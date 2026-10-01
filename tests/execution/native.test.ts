/**
 * 原生执行专项验收：运行真实沙箱、文件操作和进程，验证越界拒绝与进程终止。
 * 只使用本例创建的临时工作区；独立命令开启，不能用平台跳过结果冒充隔离已验收。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileResultStore,
  LocalCommandConfigFiles,
  LocalWorkspace,
  NativeExecutionGateway,
  ShellCommandAnalyzer,
  SqliteChatStore,
  ToolRegistry,
} from "../../packages/adapters/src/index.js";
import {
  CommandPolicyService,
  ToolService,
} from "../../packages/application/src/index.js";
import type {
  JsonValue,
  Workspace,
} from "../../packages/contracts/src/index.js";
import { AGENT_LIMITS } from "../../packages/contracts/src/index.js";

describe.runIf(process.env.MYAGENT_TEST_NATIVE === "1")("真实原生沙箱", () => {
  let root: string;
  let work: string;
  let workspace: Workspace;
  let registry: ToolRegistry;
  let gateway: NativeExecutionGateway;
  let acceptedWorkers: Set<string>;
  beforeEach(async () => {
    acceptedWorkers = new Set();
    root = await realpath(
      await mkdtemp(join(tmpdir(), "myagent-native-test-")),
    );
    work = join(root, "work");
    const data = join(root, "data");
    await mkdir(work);
    await mkdir(data);
    const paths = new LocalWorkspace([data, process.cwd()]);
    workspace = await paths.create(work, "验收工作区");
    registry = new ToolRegistry(paths);
    gateway = new NativeExecutionGateway({
      dataDir: data,
      runtimeRoot: process.cwd(),
      protectedPaths: [data],
    });
  });
  afterEach(async () => {
    await gateway?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function call(
    name: string,
    args: Record<string, JsonValue>,
    timeoutMs = 5000,
    executionMode: "standard" | "full_access" = "standard",
  ) {
    const context = {
      runId: "native-run",
      executionMode,
      sessionId: "native-session",
      stepId: "native-step",
      invocationId: randomUUID(),
      workspace,
    };
    const prepared = await registry.prepare(
      name,
      JSON.stringify(args),
      context,
    );
    return gateway.dispatch(
      {
        context,
        prepared,
        attemptId: randomUUID(),
        timeoutMs,
        authorizedResources: prepared.resources,
        onAccepted: async (id) => {
          if (id) acceptedWorkers.add(id);
        },
      },
      new AbortController().signal,
    );
  }

  it("只读命令真实隔离写入与网络，完全访问 Worker 不串用；只读进程可并行", async () => {
    const target = join(work, "read-only.txt");
    await writeFile(target, "original");
    // 先创建同 Run 完全访问 Worker，随后只读命令必须创建另一种权限的 Worker。
    const full = await call(
      "exec_command",
      { command: "pwd", yieldTimeMs: 1000 },
      5000,
      "full_access",
    );
    expect(full.outcome).toBe("succeeded");
    const denied = await call(
      "exec_command",
      {
        command: `printf changed > '${target}'`,
        readOnly: true,
        yieldTimeMs: 1000,
      },
      5000,
      "full_access",
    );
    expect(denied.outcome).toBe("failed");
    expect(await readFile(target, "utf8")).toBe("original");
    expect(acceptedWorkers.size).toBeGreaterThanOrEqual(2);
    const sub = join(work, "read-scope");
    await mkdir(sub);
    await writeFile(join(sub, "inside.txt"), "inside");
    const scoped = await call(
      "exec_command",
      {
        command: "cat inside.txt",
        cwd: sub,
        readOnly: true,
        yieldTimeMs: 1000,
      },
      5000,
      "full_access",
    );
    expect(scoped.outcome).toBe("succeeded");
    expect(JSON.stringify(scoped)).toContain("inside");
    const outsideScope = await call(
      "exec_command",
      {
        command: "cat ../read-only.txt",
        cwd: sub,
        readOnly: true,
        yieldTimeMs: 1000,
      },
      5000,
      "full_access",
    );
    expect(outsideScope.outcome).toBe("failed");
    const results = await Promise.all(
      [1, 2].map(() =>
        call(
          "exec_command",
          {
            command: `sleep 2; cat '${target}'`,
            readOnly: true,
            yieldTimeMs: 0,
          },
          10000,
          "full_access",
        ),
      ),
    );
    expect(results.every((r) => r.outcome === "succeeded")).toBe(true);
    expect(
      gateway.processes("native-run").filter((p) => p.status === "running"),
    ).toHaveLength(2);
    for (const r of results) {
      const id = (r.data as { processId: string }).processId;
      const finished = await call("read_process", {
        processId: id,
        waitMs: 5000,
      });
      expect(JSON.stringify(finished)).toContain("original");
    }
  }, 30000);

  it("完全访问实际读写项目外目录，同一 Run 标准 Worker 不复用完全访问权限", async () => {
    const outside = join(root, "outside-full.txt");
    await writeFile(outside, "outside-original");
    const full = await call(
      "exec_command",
      {
        command: `cat '${outside}'; printf updated > '${outside}'`,
        yieldTimeMs: 1000,
      },
      5000,
      "full_access",
    );
    expect(full.outcome).toBe("succeeded");
    expect(JSON.stringify(full)).toContain("outside-original");
    expect(await readFile(outside, "utf8")).toBe("updated");
    const standard = await call("exec_command", {
      command: `cat '${outside}'`,
      yieldTimeMs: 1000,
    });
    expect(standard.outcome).toBe("failed");
    expect(JSON.stringify(standard)).not.toContain("updated");
    expect(acceptedWorkers.size).toBe(2);
    expect((await gateway.closeRun("native-run")).confirmed).toBe(true);
  }, 20000);
  it("并发首次读取复用同一权限 Worker，关闭后所有已登记进程均收拢", async () => {
    await writeFile(join(work, "shared.txt"), "shared");
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () =>
        call("read_file", { path: "shared.txt" }),
      ),
    );
    expect(receipts.every((r) => r.outcome === "succeeded")).toBe(true);
    expect(acceptedWorkers.size).toBe(1);
    expect((await gateway.closeRun("native-run")).confirmed).toBe(true);
  }, 30000);
  it("执行真实命令并拒绝读取或写入工作区外的测试资源", async () => {
    const secret = join(root, "outside-secret");
    await writeFile(secret, "outside-canary-97531");
    const denied = await call("exec_command", {
      command: `cat '${secret}'; printf changed > '${join(root, "outside-write")}'`,
      yieldTimeMs: 1000,
    });
    expect(denied.outcome).toBe("failed");
    expect(JSON.stringify(denied)).not.toContain("outside-canary-97531");
    expect(existsSync(join(root, "outside-write"))).toBe(false);
    const allowed = await call("exec_command", {
      command: "printf hello > allowed.txt; cat allowed.txt",
      yieldTimeMs: 1000,
    });
    expect(allowed.outcome).toBe("succeeded");
    expect(await readFile(join(work, "allowed.txt"), "utf8")).toBe("hello");
  }, 20000);
  it("命令长日志保留真实头尾，退出码独立保留，分页可还原完整采集内容", async () => {
    const log = `LOG_HEAD\n${"middle-line\n".repeat(1400)}LOG_TAIL_ERROR\n`;
    await writeFile(join(work, "long-log.txt"), log);
    const receipt = await call("exec_command", {
      command: "cat long-log.txt; exit 7",
      yieldTimeMs: 1000,
    });
    const data = receipt.data as {
      output: string;
      outputTruncated: boolean;
      exitCode: number;
      processId: string;
    };
    expect(data.exitCode).toBe(7);
    expect(data.outputTruncated).toBe(true);
    expect(data.output.length).toBeLessThanOrEqual(6000);
    const preview = JSON.parse(data.output).preview as string;
    expect(preview).toMatch(/^LOG_HEAD/);
    expect(preview).toMatch(/LOG_TAIL_ERROR\n$/);
    expect(preview).toContain("read_process");
    let cursor = "0";
    let recovered = "";
    while (Number(cursor) < Buffer.byteLength(log)) {
      const page = (
        await call("read_process", { processId: data.processId, cursor })
      ).data as { output: string; cursor: string };
      expect(Number(page.cursor)).toBeGreaterThan(Number(cursor));
      recovered += page.output;
      cursor = page.cursor;
    }
    expect(recovered).toBe(log);
  }, 20000);
  it("文件创建、读取哈希和精确编辑均经过真实沙箱子进程", async () => {
    const created = await call("write_file", {
      path: "note.txt",
      content: "你好 MyAgent",
      expectedHash: null,
    });
    expect(created.outcome).toBe("succeeded");
    const read = await call("read_file", { path: "note.txt" });
    expect(read.outcome).toBe("succeeded");
    const data = read.data as { sha256: string; text: string };
    expect(data.text).toBe("你好 MyAgent");
    const edited = await call("edit_file", {
      path: "note.txt",
      oldText: "MyAgent",
      newText: "工具系统",
      expectedHash: data.sha256,
    });
    expect(edited.outcome).toBe("succeeded");
    expect(await readFile(join(work, "note.txt"), "utf8")).toBe(
      "你好 工具系统",
    );
    const stale = await call("write_file", {
      path: "note.txt",
      content: "旧版本覆盖",
      expectedHash: data.sha256,
    });
    expect(stale.error?.code).toBe("file_conflict");
  }, 30000);
  it("命令会话可输入、读取、确认终止，主进程退出时不遗留同组子进程", async () => {
    const started = await call(
      "exec_command",
      {
        command: "read answer; printf 'got:%s' \"$answer\"; sleep 60",
        yieldTimeMs: 0,
      },
      60000,
    );
    const id = (started.data as { processId: string }).processId;
    expect(id).toBeTruthy();
    await call("write_stdin", { processId: id, input: "hello\n" });
    const output = await call("read_process", { processId: id, waitMs: 100 });
    expect(JSON.stringify(output.data)).toContain("got:hello");
    const stopped = await call("stop_process", { processId: id });
    expect((stopped.data as { status: string }).status).toBe("stopped");
    const spawned = await call("exec_command", {
      command: "sleep 60 >/dev/null 2>&1 & printf '%s' $!",
      yieldTimeMs: 1000,
    });
    const childPid = Number((spawned.data as { output: string }).output.trim());
    expect(childPid).toBeGreaterThan(1);
    expect(() => process.kill(childPid, 0)).toThrow();
  }, 30000);
  it("命令超时实际终止进程而不只是停止等待", async () => {
    const result = await call(
      "exec_command",
      { command: "sleep 60", yieldTimeMs: 1000 },
      150,
    );
    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("timeout");
    const process = gateway.processes("native-run")[0];
    expect(process?.status).toBe("stopped");
  }, 20000);
  it("真实长进程不阻塞所属 Run 的整批，停止后才允许后续文件写入", async () => {
    const store = new SqliteChatStore(join(root, "data", "state.db"));
    store.execution.put("workspaces", workspace);
    const session = store.createSession();
    store.execution.bindWorkspace(session.id, workspace.id, session.revision);
    const run = store.beginRun({
      sessionId: session.id,
      expectedRevision: store.snapshot(session.id).session.revision,
      requestId: randomUUID(),
      fingerprint: "process-lock",
      kind: "send",
      content: "真实进程锁验证",
      model: "fixture",
      contextTrimmed: false,
      executionMode: "full_access",
    });
    const tools = new ToolService({
      store: store.execution,
      chat: store,
      registry,
      gateway,
      results: new FileResultStore(join(root, "data"), store.execution),
      workspaces: new LocalWorkspace([join(root, "data")]),
      id: randomUUID,
    });
    const executor = tools.forRun(run.id, session.id);
    await executor.snapshot?.();
    const batch = {
      runId: run.id,
      stepId: "first",
      signal: AbortSignal.timeout(10000),
      limits: AGENT_LIMITS,
      onUpdate: async () => {},
      calls: [
        {
          id: "sleep",
          name: "exec_command",
          arguments: JSON.stringify({ command: "sleep 60", yieldTimeMs: 0 }),
        },
        {
          id: "write-blocked",
          name: "exec_command",
          arguments: JSON.stringify({ command: "printf ready > marker.txt" }),
        },
      ],
    };
    try {
      const result = await executor.executeBatch?.(batch);
      expect(result?.[1]?.error?.code).toBe("process_resource_busy");
      expect(existsSync(join(work, "marker.txt"))).toBe(false);
      const proc = gateway.processes(run.id)[0];
      if (!proc) throw Error("没有创建真实进程");
      expect(proc.status).toBe("running");
      const next = await executor.executeBatch?.({
        ...batch,
        stepId: "manage",
        calls: [
          {
            id: "read",
            name: "read_process",
            arguments: JSON.stringify({ processId: proc.id, waitMs: 0 }),
          },
          {
            id: "stop",
            name: "stop_process",
            arguments: JSON.stringify({ processId: proc.id }),
          },
          {
            id: "write-after-stop",
            name: "exec_command",
            arguments: JSON.stringify({ command: "printf ready > marker.txt" }),
          },
        ],
      });
      expect(next?.every((r) => r.ok)).toBe(true);
      expect(
        gateway.processes(run.id).find((p) => p.id === proc.id)?.status,
      ).toBe("stopped");
      expect(await readFile(join(work, "marker.txt"), "utf8")).toBe("ready");
    } finally {
      await gateway.closeRun(run.id);
      store.close();
    }
  }, 20000);
  it("应用层审批前不删除文件，批准后真实执行；命令 allow 不扩大沙箱，交互输入无需再次审批", async () => {
    const store = new SqliteChatStore(join(root, "data", "state.db"));
    store.execution.put("workspaces", workspace);
    const paths = new LocalWorkspace([join(root, "data"), process.cwd()]);
    const commands = new CommandPolicyService(
      store.execution,
      new LocalCommandConfigFiles(join(root, "data"), store.execution),
      new ShellCommandAnalyzer(),
      paths,
    );
    const tools = new ToolService({
      store: store.execution,
      chat: store,
      registry,
      gateway,
      commands,
      results: new FileResultStore(join(root, "data"), store.execution),
      workspaces: paths,
      id: randomUUID,
    });
    const session = store.createSession();
    store.execution.bindWorkspace(session.id, workspace.id, session.revision);
    const run = store.beginRun({
      sessionId: session.id,
      expectedRevision: store.snapshot(session.id).session.revision,
      requestId: randomUUID(),
      fingerprint: "native-command-policy",
      kind: "send",
      content: "真实命令验收",
      model: "fixture",
      contextTrimmed: false,
    });
    const executor = tools.forRun(run.id, session.id);
    await executor.snapshot?.();
    const execute = (
      id: string,
      name: string,
      args: Record<string, JsonValue>,
    ) =>
      executor.executeBatch?.({
        runId: run.id,
        stepId: id,
        calls: [{ id, name, arguments: JSON.stringify(args) }],
        signal: new AbortController().signal,
        limits: AGENT_LIMITS,
        onUpdate: async () => {},
      });
    const approve = () => {
      const approval = store.execution
        .list("approvals", { runId: run.id })
        .find((item) => item.status === "pending");
      if (!approval) throw new Error("missing command approval");
      tools.decide(approval.id, {
        requestId: randomUUID(),
        decision: "allow",
        scope: "once",
      });
      store.execution.setRunStatus(run.id, "running");
    };
    try {
      await writeFile(join(work, "only-test.txt"), "temporary fixture");
      const remove = () =>
        execute("remove", "exec_command", {
          command: "rm only-test.txt",
          yieldTimeMs: 1000,
        });
      await expect(remove()).rejects.toMatchObject({
        code: "execution_paused",
      });
      expect(existsSync(join(work, "only-test.txt"))).toBe(true);
      approve();
      expect((await remove())?.[0]?.ok).toBe(true);
      expect(existsSync(join(work, "only-test.txt"))).toBe(false);
      const config = await commands.view({ scope: "user" });
      await commands.save({
        scope: "user",
        expectedRevision: config.revision,
        text: '{"schemaVersion":1,"rules":[{"id":"cat","pattern":["cat"],"decision":"allow"}]}',
      });
      const outside = join(root, "outside-command-policy");
      await writeFile(outside, "native-command-secret-58394");
      const result = await execute("outside", "exec_command", {
        command: `cat '${outside}'`,
        yieldTimeMs: 1000,
      });
      expect(result?.[0]?.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(
        "native-command-secret-58394",
      );
      const interactive = () =>
        execute("interactive", "exec_command", {
          command: 'read answer; printf "got:%s" "$answer"',
          yieldTimeMs: 0,
        });
      await expect(interactive()).rejects.toMatchObject({
        code: "execution_paused",
      });
      approve();
      const started = await interactive();
      const processData = started?.[0]?.data as
        | { processId: string }
        | undefined;
      if (!processData?.processId) throw new Error("missing process");
      const processId = processData.processId;
      const approvals = store.execution.list("approvals").length;
      expect(
        (
          await execute("stdin", "write_stdin", {
            processId,
            input: "command-test\n",
          })
        )?.[0]?.ok,
      ).toBe(true);
      const output = await execute("read", "read_process", {
        processId,
        waitMs: 100,
      });
      expect(JSON.stringify(output)).toContain("got:command-test");
      expect(store.execution.list("approvals")).toHaveLength(approvals);
    } finally {
      await gateway.closeRun(run.id);
      store.close();
    }
  }, 30000);
});
