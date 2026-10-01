/**
 * 执行核心验证：真实 SQLite 和文件仓储验证版本冲突、授权、分页、调度与迟到保护。
 * 本文件不把直接文件调用当成沙箱证据；OS 隔离由独立 native.test.ts 验收。
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executeFileTool,
  FileResultStore,
  LocalWorkspace,
  SqliteChatStore,
  ToolRegistry,
} from "../../packages/adapters/src/index.js";
import {
  ExecutionCoordinator,
  ToolService,
} from "../../packages/application/src/index.js";
import {
  AGENT_LIMITS,
  AppError,
  type JsonValue,
  type PermissionGrant,
  type ProcessSession,
  type ToolCall,
  type ToolDefinition,
  type Workspace,
} from "../../packages/contracts/src/index.js";
import {
  type ExecutionContext,
  type ExecutionGateway,
  evaluatePermissions,
  type ModelMessage,
  type ModelPort,
  ResourceLockManager,
  runAgent,
  scheduleBatch,
} from "../../packages/kernel/src/index.js";

let root: string;
let work: string;
let store: SqliteChatStore;
let registry: ToolRegistry;
let workspace: Workspace;
let paths: LocalWorkspace;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "myagent-tools-core-")));
  work = join(root, "work");
  await mkdir(work);
  store = new SqliteChatStore(join(root, "data", "state.db"));
  paths = new LocalWorkspace([join(root, "data")]);
  workspace = await paths.create(work, "测试");
  registry = new ToolRegistry(paths);
  store.execution.put("workspaces", workspace);
});
afterEach(async () => {
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
function context(): ExecutionContext {
  return {
    sessionId: "session",
    runId: "run",
    stepId: "step",
    invocationId: randomUUID(),
    workspace,
  };
}
function run(executionMode: "standard" | "full_access" = "standard") {
  const session = store.createSession();
  store.execution.bindWorkspace(session.id, workspace.id, session.revision);
  const snapshot = store.snapshot(session.id);
  return store.beginRun({
    sessionId: session.id,
    expectedRevision: snapshot.session.revision,
    requestId: randomUUID(),
    fingerprint: "fixture",
    kind: "send",
    content: "测试",
    model: "fixture",
    contextTrimmed: false,
    executionMode,
  });
}
describe("参数、文件和结果", () => {
  it("拒绝未知工具、无效 JSON 和类型错误，规范化新文件父路径", async () => {
    await expect(
      registry.prepare("no_such_tool", "{}", context()),
    ).rejects.toMatchObject({ code: "unknown_tool" });
    await expect(
      registry.prepare("read_file", "{", context()),
    ).rejects.toMatchObject({ code: "invalid_tool_arguments" });
    await expect(
      registry.prepare("read_file", '{"path":12}', context()),
    ).rejects.toMatchObject({ code: "invalid_tool_arguments" });
    const tool = await registry.prepare(
      "read_file",
      '{"path":"sub/../note.txt"}',
      context(),
    );
    expect(tool.arguments.path).toBe(join(work, "note.txt"));
  });
  it("工作区符号链接外跳需要额外权限，应用数据路径始终拒绝", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(work, "escape"));
    const tool = await registry.prepare(
      "read_file",
      '{"path":"escape/test.txt"}',
      context(),
    );
    const decision = evaluatePermissions({
      workspace,
      sessionId: "session",
      invocationId: "invocation",
      fingerprint: tool.fingerprint,
      resources: tool.resources,
      grants: [],
    });
    expect(decision.decision).toBe("ask");
    await symlink(join(root, "data"), join(work, "secrets"));
    await expect(
      registry.prepare("read_file", '{"path":"secrets/state.db"}', context()),
    ).rejects.toMatchObject({ code: "protected_path" });
  });
  it("授权后符号链接被替换时最终复核拒绝派发", async () => {
    const a = join(work, "a");
    const b = join(work, "b");
    await mkdir(a);
    await mkdir(b);
    await symlink(a, join(work, "link"));
    const prepared = await registry.prepare(
      "read_file",
      '{"path":"link/test"}',
      context(),
    );
    await rm(join(work, "link"));
    await symlink(b, join(work, "link"));
    // 原始请求再次规范化指向不同资源，已批准指纹不能覆盖这个新目标。
    const changed = await registry.prepare(
      "read_file",
      '{"path":"link/test"}',
      context(),
    );
    expect(changed.fingerprint).not.toBe(prepared.fingerprint);
    await rm(a, { recursive: true });
    await symlink(b, a);
    await expect(
      registry.revalidate(prepared, context()),
    ).rejects.toMatchObject({ code: "execution_changed" });
  });
  it("文件创建与哈希保护避免过期编辑覆盖用户改动", async () => {
    const path = join(work, "note.txt");
    const scopes = [
      { kind: "path" as const, target: work, access: "write" as const },
    ];
    const created = (await executeFileTool(
      "write_file",
      { path, content: "原始内容", expectedHash: null },
      scopes,
    )) as { afterHash: string };
    await writeFile(path, "用户新修改");
    await expect(
      executeFileTool(
        "edit_file",
        {
          path,
          oldText: "原始内容",
          newText: "覆盖",
          expectedHash: created.afterHash,
        },
        scopes,
      ),
    ).rejects.toMatchObject({ code: "file_conflict" });
    expect(await readFile(path, "utf8")).toBe("用户新修改");
  });
  it("结果分页按会话隔离，模型视图明确截断且完整文件保留", async () => {
    const active = run();
    const results = new FileResultStore(join(root, "data"), store.execution);
    const ctx = { ...context(), runId: active.id, sessionId: active.sessionId };
    const saved = await results.save(ctx, { text: "你好".repeat(6000) });
    expect(saved.truncated).toBe(true);
    expect(saved.preview).toContain("read_tool_result");
    const page = await results.read(saved.reference.id, active.sessionId);
    expect(page.cursor).not.toBeNull();
    await expect(
      results.read(saved.reference.id, "other-session"),
    ).rejects.toMatchObject({ code: "not_found" });
    const next = await results.read(
      saved.reference.id,
      active.sessionId,
      page.cursor ?? undefined,
    );
    expect(page.text + next.text).toBe(
      JSON.stringify({ text: "你好".repeat(6000) }),
    );
  });
  it("会话删除后拒绝迟到记录，暂停 Run 仍阻止第二次启动", () => {
    const active = run();
    store.execution.setRunStatus(active.id, "waiting_approval");
    expect(store.snapshot(active.sessionId).activeRun?.id).toBe(active.id);
    expect(() =>
      store.beginRun({
        sessionId: active.sessionId,
        expectedRevision: store.snapshot(active.sessionId).session.revision,
        requestId: randomUUID(),
        fingerprint: "again",
        kind: "send",
        content: "再次启动",
        model: "fixture",
        contextTrimmed: false,
      }),
    ).toThrow();
    store.deleteSession(active.sessionId);
    expect(() =>
      store.execution.put("results", {
        id: randomUUID(),
        sessionId: active.sessionId,
        runId: active.id,
        invocationId: "late",
        bytes: 1,
        sha256: "hash",
        mimeType: "text/plain",
        captureComplete: true,
        createdAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});
describe("权限和调度", () => {
  it("批准与参数摘要绑定，拒绝规则优先，撤销后重新请求", () => {
    const resource = {
      kind: "path" as const,
      target: join(root, "outside"),
      access: "write" as const,
    };
    const grant: PermissionGrant = {
      id: "grant",
      workspaceId: workspace.id,
      sessionId: "s",
      scope: "once",
      decision: "allow",
      resources: [resource],
      fingerprint: "a",
      invocationId: "i",
      createdAt: "now",
      revokedAt: null,
    };
    const input = {
      workspace,
      sessionId: "s",
      invocationId: "i",
      fingerprint: "a",
      resources: [resource],
      grants: [grant],
    };
    expect(evaluatePermissions(input).decision).toBe("allow");
    expect(evaluatePermissions({ ...input, fingerprint: "b" }).decision).toBe(
      "ask",
    );
    expect(
      evaluatePermissions({
        ...input,
        grants: [grant, { ...grant, id: "deny", decision: "deny" }],
      }).decision,
    ).toBe("deny");
    expect(
      evaluatePermissions({
        ...input,
        grants: [{ ...grant, revokedAt: "now" }],
      }).decision,
    ).toBe("ask");
  });
  it("共享读取并行，排他屏障不会被后续调用越过", async () => {
    const events: string[] = [];
    let concurrent = 0;
    let max = 0;
    await scheduleBatch(
      ["read-a", "read-b", "write", "read-c"],
      (name) => name.startsWith("read"),
      async (name) => {
        concurrent++;
        max = Math.max(max, concurrent);
        events.push(`start:${name}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push(`end:${name}`);
        concurrent--;
      },
      2,
      new AbortController().signal,
    );
    expect(max).toBe(2);
    expect(events.indexOf("start:write")).toBeGreaterThan(
      events.indexOf("end:read-b"),
    );
    expect(events.indexOf("start:read-c")).toBeGreaterThan(
      events.indexOf("end:write"),
    );
  });
  it("目录写锁覆盖子文件，等待可以取消", async () => {
    const locks = new ResourceLockManager();
    const controller = new AbortController();
    const first = await locks.acquire(
      [{ key: `path:${work}`, mode: "write" }],
      controller.signal,
    );
    let acquired = false;
    const next = locks
      .acquire(
        [{ key: `path:${join(work, "file")}`, mode: "read" }],
        controller.signal,
      )
      .then((release) => {
        acquired = true;
        release();
      });
    await Promise.resolve();
    expect(acquired).toBe(false);
    first();
    await next;
    expect(acquired).toBe(true);
    const holding = await locks.acquire(
      [{ key: "mcp:x", mode: "write" }],
      new AbortController().signal,
    );
    const waiting = locks.acquire(
      [{ key: "mcp:x", mode: "write" }],
      controller.signal,
    );
    controller.abort(new AppError("cancelled", "停止"));
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
    holding();
  });
});
describe("应用批次与恢复", () => {
  it("长进程返回后同批冲突动作不派发，模型仍可读/停进程并继续；重复批次不重放", async () => {
    const active = run("full_access");
    const processes: ProcessSession[] = [];
    const dispatched: string[] = [];
    const gateway: ExecutionGateway = {
      async dispatch(request) {
        const name = request.prepared.descriptor.name;
        dispatched.push(name);
        await request.onAccepted?.(null);
        let data: JsonValue = { text: "ok" };
        if (name === "exec_command" && !processes.length) {
          processes.push({
            id: "process-long",
            sessionId: active.sessionId,
            runId: active.id,
            invocationId: request.context.invocationId,
            workerId: "fixture",
            pid: 1,
            status: "running",
            exitCode: null,
            signal: null,
            outputRef: "",
            createdAt: new Date().toISOString(),
            endedAt: null,
          });
          data = { processId: "process-long", status: "running" };
        } else if (name === "stop_process") {
          processes[0]!.status = "exited";
          data = { processId: "process-long", status: "exited" };
        }
        return {
          attemptId: request.attemptId,
          invocationId: request.context.invocationId,
          outcome: "succeeded",
          data,
          error: null,
          effectsPossible: name === "exec_command",
          completedAt: new Date().toISOString(),
        };
      },
      async reconcile() {
        return null;
      },
      async closeRun() {
        return { confirmed: true };
      },
      processes() {
        return structuredClone(processes);
      },
      async revoke() {},
      async close() {},
    };
    const tools = new ToolService({
      store: store.execution,
      chat: store,
      registry,
      gateway,
      results: new FileResultStore(join(root, "data"), store.execution),
      workspaces: paths,
      id: randomUUID,
    });
    const executor = tools.forRun(active.id, active.sessionId);
    await executor.snapshot?.();
    const batch = {
      runId: active.id,
      stepId: "batch-1",
      signal: AbortSignal.timeout(1000),
      limits: AGENT_LIMITS,
      onUpdate: async () => {},
      calls: [
        {
          id: "long",
          name: "exec_command",
          arguments: '{"command":"long-running"}',
        },
        {
          id: "blocked",
          name: "exec_command",
          arguments: '{"command":"next-command"}',
        },
        {
          id: "read-file",
          name: "read_file",
          arguments: '{"path":"note.txt"}',
        },
      ],
    };
    const results = await executor.executeBatch?.(batch);
    expect(results?.map((r) => r.error?.code ?? "ok")).toEqual([
      "ok",
      "process_resource_busy",
      "process_resource_busy",
    ]);
    expect(results?.[1]?.modelContent).toContain("process-long");
    expect(results?.[1]?.modelContent).toContain('"executed":false');
    await executor.executeBatch?.(batch);
    expect(dispatched).toEqual(["exec_command"]);
    const managed = await executor.executeBatch?.({
      ...batch,
      stepId: "batch-2",
      calls: [
        {
          id: "poll",
          name: "read_process",
          arguments: '{"processId":"process-long"}',
        },
        {
          id: "stop",
          name: "stop_process",
          arguments: '{"processId":"process-long"}',
        },
        {
          id: "retry-new",
          name: "exec_command",
          arguments: '{"command":"next-command"}',
        },
      ],
    });
    expect(managed?.every((r) => r.ok)).toBe(true);
    expect(dispatched).toEqual([
      "exec_command",
      "read_process",
      "stop_process",
      "exec_command",
    ]);
    expect(store.getRun(active.id).status).toBe("running");
  });

  it("保留锁只快速拒绝所属 Run 的冲突动作，其他 Run 仍排队且可取消", async () => {
    const coordinator = new ExecutionCoordinator();
    const keys = [{ key: "path:/project", mode: "write" as const }];
    const signal = new AbortController().signal;
    const release = coordinator.retainProcess(
      "owner",
      "p1",
      keys,
      await coordinator.acquire("owner", keys, signal),
    );
    expect(() =>
      coordinator.acquire(
        "owner",
        [{ key: "path:/project/file", mode: "read" }],
        signal,
      ),
    ).toThrow(/p1/);
    const control = await coordinator.acquire(
      "owner",
      [{ key: "process:p1", mode: "write" }],
      signal,
    );
    control();
    const nonconflict = await coordinator.acquire(
      "owner",
      [{ key: "path:/unrelated", mode: "write" }],
      signal,
    );
    nonconflict();
    const cancelled = new AbortController();
    const abandoned = coordinator.acquire("other", keys, cancelled.signal);
    cancelled.abort(new Error("cancel"));
    await expect(abandoned).rejects.toThrow("cancel");
    let acquired = false;
    const waiting = coordinator
      .acquire("other", keys, signal)
      .then((unlock) => {
        acquired = true;
        unlock();
      });
    await Promise.resolve();
    expect(acquired).toBe(false);
    release();
    release();
    await waiting;
    expect(acquired).toBe(true);
    (await coordinator.acquire("owner", keys, signal))();
  });
  it("等待批准时不执行，批准后复用原模型响应；重复批次不重复派发", async () => {
    const active = run();
    const dispatched: string[] = [];
    const gateway: ExecutionGateway = {
      async dispatch(request) {
        dispatched.push(request.context.invocationId);
        await request.onAccepted?.(null);
        return {
          attemptId: request.attemptId,
          invocationId: request.context.invocationId,
          outcome: "succeeded",
          data: { text: "fixture" },
          error: null,
          effectsPossible: false,
          completedAt: new Date().toISOString(),
        };
      },
      async reconcile() {
        return null;
      },
      async closeRun() {
        return { confirmed: true };
      },
      processes() {
        return [];
      },
      async revoke() {},
      async close() {},
    };
    const tools = new ToolService({
      store: store.execution,
      chat: store,
      registry,
      gateway,
      results: new FileResultStore(join(root, "data"), store.execution),
      workspaces: paths,
      id: randomUUID,
    });
    const executor = tools.forRun(active.id, active.sessionId);
    await executor.snapshot?.();
    const calls: ToolCall[] = [
      {
        id: "read",
        name: "read_file",
        arguments: JSON.stringify({ path: join(root, "outside.txt") }),
      },
    ];
    const batch = {
      runId: active.id,
      stepId: "step",
      calls,
      signal: new AbortController().signal,
      limits: AGENT_LIMITS,
      onUpdate: async () => {},
    };
    await expect(executor.executeBatch?.(batch)).rejects.toMatchObject({
      code: "execution_paused",
    });
    expect(dispatched).toHaveLength(0);
    const approval = store.execution.list("approvals", { runId: active.id })[0];
    if (!approval) throw new Error("missing approval");
    tools.decide(approval.id, {
      requestId: "decision",
      decision: "allow",
      scope: "workspace",
    });
    store.execution.setRunStatus(active.id, "running");
    const results = await executor.executeBatch?.(batch);
    expect(results?.[0]?.ok).toBe(true);
    await executor.executeBatch?.(batch);
    expect(dispatched).toHaveLength(1);
  });
  it("新增注册工具无需修改 Loop，协议结果保持调用 ID 配对", async () => {
    let requests = 0;
    const inputs: readonly ModelMessage[][] = [];
    const model: ModelPort = {
      async *stream(
        messages,
        _signal,
        definitions?: readonly ToolDefinition[],
      ) {
        (inputs as ModelMessage[][]).push([...messages]);
        requests++;
        expect(definitions?.[0]?.name).toBe("custom_tool");
        yield {
          type: "done",
          finishReason: requests === 1 ? "tool_calls" : "stop",
          usage: null,
          response:
            requests === 1
              ? {
                  content: "",
                  toolCalls: [
                    { id: "a", name: "custom_tool", arguments: "{}" },
                  ],
                }
              : { content: "完成", toolCalls: [] },
        };
      },
    };
    const result = await runAgent({
      runId: "custom",
      current: [{ role: "user", content: "执行" }],
      model,
      signal: new AbortController().signal,
      tools: {
        definitions: [
          {
            name: "custom_tool",
            description: "测试扩展",
            parameters: { type: "object" },
          },
        ],
        async execute() {
          return { value: 42 } as JsonValue;
        },
      },
      onEvent: () => {},
    });
    expect(result.finishReason).toBe("stop");
    expect(requests).toBe(2);
    expect(inputs[1]?.at(-1)).toMatchObject({ role: "tool", callId: "a" });
  });
});

it("参数错误指出字段与范围，不回显参数正文，等待工具给出事件式修正方法", async () => {
  await expect(
    registry.prepare("wait_agents", '{"timeoutMs":180000}', context()),
  ).rejects.toThrow(/timeoutMs.*120000.*不要改用 sleep/);
  await expect(
    registry.prepare(
      "read_process",
      '{"processId":"p","waitMs":15000}',
      context(),
    ),
  ).rejects.toThrow(/waitMs.*10000/);
  await expect(
    registry.prepare(
      "exec_command",
      '{"cmd":"secret-not-for-errors"}',
      context(),
    ),
  ).rejects.toThrow(/command/);
  try {
    await registry.prepare(
      "exec_command",
      '{"cmd":"secret-not-for-errors"}',
      context(),
    );
  } catch (error) {
    expect(String(error)).not.toContain("secret-not-for-errors");
  }
});

it("只读命令共享锁，未知 Shell 保持互斥，完全访问必须显式选择只读", async () => {
  const read = await registry.prepare(
    "exec_command",
    '{"command":"cat a.txt"}',
    context(),
  );
  expect(read.readOnlyExecution).toBe(true);
  expect(read.descriptor.concurrency).toBe("shared");
  expect(read.lockKeys.every((k) => k.mode === "read")).toBe(true);
  const write = await registry.prepare(
    "exec_command",
    '{"command":"cat a.txt > b.txt"}',
    context(),
  );
  expect(write.readOnlyExecution).toBe(false);
  expect(write.descriptor.effects).toBe("unknown");
  const full = { ...context(), executionMode: "full_access" as const };
  expect(
    (await registry.prepare("exec_command", '{"command":"cat a.txt"}', full))
      .readOnlyExecution,
  ).toBe(false);
  const explicit = await registry.prepare(
    "exec_command",
    '{"command":"python3 script.py","readOnly":true}',
    full,
  );
  expect(explicit.readOnlyExecution).toBe(true);
  expect(explicit.descriptor.concurrency).toBe("shared");
  await expect(
    registry.prepare(
      "exec_command",
      JSON.stringify({
        command: "pwd",
        readOnly: true,
        additionalPaths: [{ path: work, access: "write" }],
      }),
      full,
    ),
  ).rejects.toThrow(/write/);
  await expect(
    registry.prepare(
      "exec_command",
      '{"command":"pwd","readOnly":true,"networkDomains":["example.com"]}',
      full,
    ),
  ).rejects.toThrow(/网络/);
  await registry.revalidate(read, context());
  const writeA = await registry.prepare(
    "write_file",
    '{"path":"a.txt","content":"a","expectedHash":null}',
    context(),
  );
  const writeB = await registry.prepare(
    "write_file",
    '{"path":"b.txt","content":"b","expectedHash":null}',
    context(),
  );
  const coordinator = new ExecutionCoordinator();
  const signal = new AbortController().signal;
  const unlockA = await coordinator.acquire("a", writeA.lockKeys, signal);
  const unlockB = await coordinator.acquire("b", writeB.lockKeys, signal);
  unlockB();
  unlockA();
  const sub = join(work, "sub");
  await mkdir(sub);
  const scoped = await registry.prepare(
    "exec_command",
    JSON.stringify({ command: "ls", cwd: sub, readOnly: true }),
    full,
  );
  expect(scoped.lockKeys).toEqual([{ key: `path:${sub}`, mode: "read" }]);
  const unlockRead = await coordinator.acquire(
    "reader",
    scoped.lockKeys,
    signal,
  );
  (await coordinator.acquire("writer", writeB.lockKeys, signal))();
  unlockRead();
});

it("跨 Run 长锁有界返回持有者与进程，取消队列后不迟到派发；持锁方不能等待团队", async () => {
  const coordinator = new ExecutionCoordinator(20);
  const keys = [{ key: "path:/shared", mode: "write" as const }];
  const signal = new AbortController().signal;
  const release = coordinator.retainProcess(
    "owner",
    "process-1",
    keys,
    await coordinator.acquire("owner", keys, signal, {
      invocationId: "inv-owner",
      toolName: "exec_command",
    }),
  );
  const blocked: string[] = [];
  await expect(
    coordinator.acquire(
      "member",
      [{ key: "path:/shared/report.md", mode: "write" }],
      signal,
      { onBlocked: (v) => blocked.push(JSON.stringify(v)) },
    ),
  ).rejects.toMatchObject({
    code: "resource_busy",
    message: expect.stringMatching(/owner.*process-1.*wait_agents/),
  });
  expect(blocked.join()).toContain("inv-owner");
  expect(coordinator.waitConflict("owner")).toContain("process-1");
  expect(coordinator.waitConflict("member")).toBeUndefined();
  release();
  expect(coordinator.waitConflict("owner")).toBeUndefined();
  (await coordinator.acquire("member", keys, signal))();
});

it("两个 Run 的只读命令真实经过共享协调器同时派发，冲突写入等待且超时不产生 attempt", async () => {
  const coordinator = new ExecutionCoordinator(30);
  const first = run("full_access"),
    second = run("full_access"),
    writer = run("full_access");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatched: string[] = [];
  const gateway: ExecutionGateway = {
    async dispatch(request) {
      dispatched.push(request.context.runId);
      await request.onAccepted?.("fixture");
      await gate;
      return {
        attemptId: request.attemptId,
        outcome: "succeeded",
        data: { read: true },
        invocationId: request.context.invocationId,
        error: null,
        effectsPossible: false,
        completedAt: new Date().toISOString(),
      };
    },
    async reconcile() {
      return null;
    },
    async closeRun() {
      return { confirmed: true };
    },
    processes() {
      return [];
    },
    async revoke() {},
    async close() {},
  };
  const service = new ToolService({
    store: store.execution,
    chat: store,
    registry,
    gateway,
    coordinator,
    results: new FileResultStore(join(root, "data"), store.execution),
    workspaces: paths,
    id: randomUUID,
  });
  const execute = async (active: ReturnType<typeof run>, tool: ToolCall) => {
    const executor = service.forRun(active.id, active.sessionId);
    await executor.snapshot?.();
    return executor.executeBatch!({
      runId: active.id,
      stepId: `${active.id}:1`,
      calls: [tool],
      limits: { ...AGENT_LIMITS },
      signal: new AbortController().signal,
      onUpdate: async () => {},
    });
  };
  const reading = [first, second].map((active) =>
    execute(active, {
      id: randomUUID(),
      name: "exec_command",
      arguments: '{"command":"cat file.txt","readOnly":true}',
    }),
  );
  try {
    await expect.poll(() => dispatched.length).toBe(2);
    const result = await execute(writer, {
      id: randomUUID(),
      name: "write_file",
      arguments: '{"path":"file.txt","content":"changed","expectedHash":null}',
    });
    expect(result[0]?.error?.code).toBe("resource_busy");
    expect(store.execution.list("attempts", { runId: writer.id })).toHaveLength(
      0,
    );
    expect(store.getRun(writer.id).status).toBe("running");
  } finally {
    release();
    await Promise.all(reading);
  }
  expect(dispatched).toEqual(expect.arrayContaining([first.id, second.id]));
});
