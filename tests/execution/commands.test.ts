/**
 * 命令权限验证：真实 WASM、文件、SQLite 与应用审批；派发替身只用于计数，不冒充原生隔离。
 * 所有规则和命令目标均在本测试的临时目录，绝不读写用户规则或运行危险测试命令。
 */

import { randomUUID } from "node:crypto";
import {
  chmod,
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
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileResultStore,
  LocalCommandConfigFiles,
  LocalWorkspace,
  ShellCommandAnalyzer,
  SqliteChatStore,
  ToolRegistry,
} from "../../packages/adapters/src/index.js";
import {
  CommandPolicyService,
  parseCommandRules,
  ToolService,
} from "../../packages/application/src/index.js";
import {
  AGENT_LIMITS,
  type CommandConfigTarget,
  type CommandRule,
  type Workspace,
} from "../../packages/contracts/src/index.js";
import {
  type ExecutionContext,
  type ExecutionGateway,
  evaluateCommands,
  type ToolBatchOptions,
} from "../../packages/kernel/src/index.js";

let root: string;
let work: string;
let store: SqliteChatStore;
let paths: LocalWorkspace;
let workspace: Workspace;
let registry: ToolRegistry;
let files: LocalCommandConfigFiles;
let service: CommandPolicyService;
let tools: ToolService;
let dispatches: string[];
let acceptedHook: (() => Promise<void>) | undefined;
const analyzer = new ShellCommandAnalyzer();
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "myagent-command-test-")));
  work = join(root, "work");
  await mkdir(work);
  store = new SqliteChatStore(join(root, "data", "state.db"));
  paths = new LocalWorkspace([join(root, "data")]);
  workspace = await paths.create(work, "命令测试");
  store.execution.put("workspaces", workspace);
  registry = new ToolRegistry(paths);
  files = new LocalCommandConfigFiles(join(root, "data"), store.execution);
  service = new CommandPolicyService(store.execution, files, analyzer, paths);
  dispatches = [];
  acceptedHook = undefined;
  const gateway: ExecutionGateway = {
    async dispatch(request) {
      await acceptedHook?.();
      await request.onAccepted?.(null);
      dispatches.push(request.context.invocationId);
      return {
        attemptId: request.attemptId,
        invocationId: request.context.invocationId,
        outcome: "succeeded",
        data: { output: "fixture" },
        error: null,
        effectsPossible: true,
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
  tools = new ToolService({
    store: store.execution,
    chat: store,
    registry,
    gateway,
    commands: service,
    results: new FileResultStore(join(root, "data"), store.execution),
    workspaces: paths,
    id: randomUUID,
  });
});
afterEach(async () => {
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
function context(): ExecutionContext {
  return {
    runId: "preview",
    sessionId: "preview",
    stepId: "preview",
    invocationId: "preview",
    workspace,
  };
}
async function assess(command: string) {
  const ctx = context();
  return service.assess(
    await registry.prepare("exec_command", JSON.stringify({ command }), ctx),
    ctx,
  );
}
async function save(rules: CommandRule[], scope: "user" | "project" = "user") {
  const target: CommandConfigTarget = {
    scope,
    ...(scope === "project" ? { workspaceId: workspace.id } : {}),
  };
  const view = await service.view(target);
  return service.save({
    ...target,
    expectedRevision: view.revision,
    text: JSON.stringify({ schemaVersion: 1, rules }),
  });
}
async function batch(
  command: string,
  extra = {},
  executionMode: "standard" | "full_access" = "standard",
) {
  const session = store.createSession();
  store.execution.bindWorkspace(session.id, workspace.id, session.revision);
  const run = store.beginRun({
    sessionId: session.id,
    expectedRevision: store.snapshot(session.id).session.revision,
    requestId: randomUUID(),
    fingerprint: randomUUID(),
    kind: "send",
    executionMode,
    content: "执行测试",
    model: "fixture",
    contextTrimmed: false,
  });
  const executor = tools.forRun(run.id, run.sessionId);
  await executor.snapshot?.();
  const input: ToolBatchOptions = {
    runId: run.id,
    stepId: "step",
    calls: [
      {
        id: "command",
        name: "exec_command",
        arguments: JSON.stringify({ command, ...extra }),
      },
    ],
    signal: new AbortController().signal,
    limits: AGENT_LIMITS,
    onUpdate: async () => {},
  };
  return { run, input, execute: () => executor.executeBatch?.(input) };
}
describe("Shell AST 与规则组合", () => {
  it.each([
    "pwd",
    "ls -la",
    "cat README.md | head -n 10",
    "cat 'a; rm -rf b'",
    'cat "a b"',
    "wc -l README.md && pwd",
    "grep -n hello README.md",
  ])("低风险静态读取：%s", async (command) => {
    expect((await assess(command)).decision).toBe("allow");
  });
  it.each([
    "rm -rf build",
    "git status",
    "npm install",
    "node script.js",
    "cat file; rm file",
    "cat file > out",
    'echo "$(touch marker)"',
    "FOO=bar cat file",
    "cat *.txt",
    "cat $FILE",
    "cat <(pwd)",
    "cat file &",
    "for f in a; do cat $f; done",
    "sh -c 'cat file'",
    "cat --unknown file",
    "rg --pre sh text",
    "find . -delete",
  ])("不明确或有副作用时询问：%s", async (command) => {
    expect((await assess(command)).decision).toBe("prompt");
  });
  it("未闭合命令明确报错且没有执行任何替换", async () => {
    await expect(assess("cat 'unclosed")).rejects.toMatchObject({
      code: "invalid_command",
    });
    await assess(`echo "$(touch '${join(work, "marker")}')"`);
    await expect(readFile(join(work, "marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("自定义规则按参数边界匹配，项目 allow 不能放宽用户 prompt 或 deny", async () => {
    await save([
      { id: "git", pattern: ["git", "status"], decision: "prompt" },
      { id: "delete", pattern: ["rm"], decision: "deny" },
    ]);
    await save(
      [
        { id: "git", pattern: ["git", "status"], decision: "allow" },
        { id: "delete", pattern: ["rm"], decision: "allow" },
      ],
      "project",
    );
    expect((await assess("git status")).decision).toBe("prompt");
    expect((await assess("rm file")).decision).toBe("deny");
    await save([{ id: "git", pattern: ["git", "status"], decision: "allow" }]);
    expect((await assess("git status --short")).decision).toBe("allow");
    expect((await assess("git status-other")).decision).toBe("prompt");
    expect((await assess("git status; node script.js")).decision).toBe(
      "prompt",
    );
  });
  it("动态或包装语法不能被宽泛 allow 放行；嵌套的显式 deny 仍生效", async () => {
    await save([
      { id: "cat", pattern: ["cat"], decision: "allow" },
      { id: "shell", pattern: ["sh"], decision: "allow" },
      { id: "rm", pattern: ["rm"], decision: "deny" },
    ]);
    expect((await assess("cat $FILE")).decision).toBe("prompt");
    expect((await assess('cat "$(rm file)"')).decision).toBe("deny");
    expect((await assess("sh -c 'rm file'")).decision).toBe("deny");
    expect((await assess("sh -c 'pwd'")).decision).toBe("prompt");
  });
  it("工作区同名程序没有系统只读豁免，二进制身份改变使批准绑定改变", async () => {
    await writeFile(join(work, "cat"), "#!/bin/sh\nexit 0\n");
    await chmod(join(work, "cat"), 0o700);
    const first = await assess("./cat file");
    expect(first.decision).toBe("prompt");
    await writeFile(join(work, "cat"), "#!/bin/sh\nexit 1\n# new\n");
    expect((await assess("./cat file")).binding).not.toBe(first.binding);
  });
  it("纯内核不依赖平台也能按整批最严格结果求值", () => {
    const command = {
      argv: ["safe"],
      executable: null,
      executableIdentity: null,
      safe: true,
      reason: "read",
    };
    expect(
      evaluateCommands(
        {
          commands: [command, { ...command, argv: ["write"], safe: false }],
          opaque: false,
          reasons: [],
        },
        [],
      ).decision,
    ).toBe("prompt");
  });
});
describe("规则文件与可信版本", () => {
  it("表单文件同源、CAS 并发保护；非法配置不会覆盖此前有效规则", async () => {
    const saved = await save([
      { id: "git", pattern: ["git"], decision: "deny" },
    ]);
    expect(JSON.parse(await readFile(saved.path, "utf8")).rules[0].id).toBe(
      "git",
    );
    await writeFile(saved.path, '{"invalid":');
    const view = await service.view({ scope: "user" });
    expect(view.error).toContain("JSON");
    expect(view.lastValid?.rules[0]?.id).toBe("git");
    expect((await assess("pwd")).decision).toBe("deny");
    await expect(
      service.save({
        scope: "user",
        text: saved.text,
        expectedRevision: saved.revision,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await readFile(saved.path, "utf8")).toBe('{"invalid":');
  });
  it("外部项目配置出现/改变/删除须确认准确版本；排版不改变信任", async () => {
    const target = { scope: "project" as const, workspaceId: workspace.id };
    const first = await service.view(target);
    await mkdir(join(work, ".myagent"));
    await writeFile(
      first.path,
      JSON.stringify({
        schemaVersion: 1,
        rules: [{ id: "git", pattern: ["git"], decision: "allow" }],
      }),
    );
    const pending = await service.view(target);
    expect(pending.pending).toBe(true);
    expect((await assess("pwd")).decision).toBe("deny");
    await expect(
      service.confirm({ ...target, expectedRevision: first.revision }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await service.confirm({ ...target, expectedRevision: pending.revision });
    expect((await assess("git status")).decision).toBe("allow");
    await writeFile(first.path, JSON.stringify(pending.document, null, 4));
    expect((await service.view(target)).pending).toBe(false);
    await rm(first.path);
    const removed = await service.view(target);
    expect(removed.pending).toBe(true);
    await service.confirm({ ...target, expectedRevision: removed.revision });
    expect((await assess("git status")).decision).toBe("prompt");
  });
  it("rename 后失败保留提交日志，重建服务可恢复准确确认且不重写外部新版本", async () => {
    const target = { scope: "project" as const, workspaceId: workspace.id };
    const before = await service.view(target);
    const write = files.write.bind(files);
    files.write = async (...args) => {
      await write(...args);
      throw new Error("after rename");
    };
    await expect(
      service.save({
        ...target,
        expectedRevision: before.revision,
        text: '{"schemaVersion":1,"rules":[{"id":"git","pattern":["git"],"decision":"allow"}]}',
      }),
    ).rejects.toThrow("after rename");
    expect(
      store.execution.list("commandFiles").some((state) => state.staged),
    ).toBe(true);
    service = new CommandPolicyService(
      store.execution,
      new LocalCommandConfigFiles(join(root, "data"), store.execution),
      analyzer,
      paths,
    );
    await service.initialize();
    expect((await service.view(target)).pending).toBe(false);
    expect(
      store.execution.list("commandFiles").some((state) => state.staged),
    ).toBe(false);
    expect((await assess("git status")).decision).toBe("allow");
    const view = await service.view(target);
    const state = store.execution
      .list("commandFiles")
      .find((value) => value.target.scope === "project");
    if (!state) throw new Error("state");
    store.execution.put("commandFiles", {
      ...state,
      staged: { text: view.text, previousRevision: before.revision },
    });
    await writeFile(
      view.path,
      '{"schemaVersion":1,"rules":[{"id":"node","pattern":["node"],"decision":"allow"}]}',
    );
    await service.initialize();
    expect((await service.view(target)).pending).toBe(true);
    expect(await readFile(view.path, "utf8")).toContain('"node"');
  });
  it("项目配置不允许符号链接越界，严格拒绝不完整规则", async () => {
    await mkdir(join(root, "other"));
    await symlink(join(root, "other"), join(work, ".myagent"));
    await expect(
      service.view({ scope: "project", workspaceId: workspace.id }),
    ).rejects.toMatchObject({ code: "protected_path" });
    for (const rules of [
      [{ id: "x", pattern: [], decision: "allow" }],
      [{ id: "x", pattern: [""], decision: "deny" }],
      [{ id: "x", pattern: ["git"], decision: "anything" }],
    ])
      expect(() =>
        parseCommandRules(JSON.stringify({ schemaVersion: 1, rules })),
      ).toThrow();
  });
  it("用户规则不能链接到模型可写项目，避免自动信任边界被降低", async () => {
    await writeFile(
      join(work, "untrusted.json"),
      '{"schemaVersion":1,"rules":[{"id":"rm","pattern":["rm"],"decision":"allow"}]}',
    );
    await symlink(
      join(work, "untrusted.json"),
      join(root, "data", "command-rules.json"),
    );
    await expect(service.view({ scope: "user" })).rejects.toMatchObject({
      code: "protected_path",
    });
    await expect(assess("rm file")).rejects.toMatchObject({
      code: "protected_path",
    });
  });
  it("v4 数据库升级当前版本，历史保持且未来版本被拒绝", () => {
    const session = store.createSession();
    store.close();
    let fixtureDb = new DatabaseSync(join(root, "data", "state.db"));
    fixtureDb.exec(
      "DROP TABLE observation_records; DROP TABLE observation_settings; DROP TABLE observation_operations; DROP TABLE team_records; ALTER TABLE sessions DROP COLUMN parent_session_id; ALTER TABLE messages DROP COLUMN origin; DROP TABLE plugin_records; DROP TABLE hook_records; DROP TABLE skill_records; DROP TABLE context_records; DROP TABLE memory_records; PRAGMA user_version = 4",
    );
    fixtureDb.close();
    store = new SqliteChatStore(join(root, "data", "state.db"));
    fixtureDb = new DatabaseSync(join(root, "data", "state.db"));
    expect(fixtureDb.prepare("PRAGMA user_version").get()?.user_version).toBe(
      13,
    );
    fixtureDb.close();
    expect(store.snapshot(session.id).session.id).toBe(session.id);
    store.close();
    fixtureDb = new DatabaseSync(join(root, "data", "state.db"));
    fixtureDb.exec("PRAGMA user_version = 14");
    fixtureDb.close();
    expect(() => new SqliteChatStore(join(root, "data", "state.db"))).toThrow(
      "数据库版本较新",
    );
  });
});
describe("审批、派发与授权隔离", () => {
  it("完全访问跳过显式命令/资源拒绝及无效规则，无审批且不污染后续标准任务", async () => {
    await save([{ id: "deny-node", pattern: ["node"], decision: "deny" }]);
    store.execution.put("grants", {
      id: "deny",
      workspaceId: workspace.id,
      sessionId: null,
      scope: "workspace",
      decision: "deny",
      resources: [{ kind: "path", target: work, access: "write" }],
      fingerprint: null,
      invocationId: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    });
    const full = await batch("node -e 'console.log(1)'", {}, "full_access");
    expect((await full.execute())?.[0]?.ok).toBe(true);
    expect(store.execution.list("approvals", { runId: full.run.id })).toEqual(
      [],
    );
    expect(
      store.execution.list("invocations", { runId: full.run.id })[0]
        ?.executionMode,
    ).toBe("full_access");
    // 持久恢复再次执行同一逻辑调用返回原回执，不会因免审批而重复执行。
    await full.execute();
    expect(dispatches).toHaveLength(1);
    const standard = await batch("node -e 'console.log(1)'");
    expect((await standard.execute())?.[0]?.error?.code).toBe(
      "permission_denied",
    );
    expect(dispatches).toHaveLength(1);
    const view = await service.view({ scope: "user" });
    await writeFile(view.path, "{broken");
    const invalid = await batch("echo trusted", {}, "full_access");
    expect((await invalid.execute())?.[0]?.ok).toBe(true);
  });
  it("模型把 executionMode 塞进工具参数不能自行提权", async () => {
    const standard = await batch("echo forged", {
      executionMode: "full_access",
    });
    expect((await standard.execute())?.[0]?.error?.code).toBe(
      "invalid_tool_arguments",
    );
    expect(dispatches).toHaveLength(0);
  });

  it("读取直接派发；旧资源长期授权不能放行命令，审批仅本次且不重复执行", async () => {
    const read = await batch("pwd");
    expect((await read.execute())?.[0]?.ok).toBe(true);
    store.execution.put("grants", {
      id: "old",
      workspaceId: workspace.id,
      sessionId: null,
      scope: "workspace",
      decision: "allow",
      resources: [{ kind: "path", target: work, access: "write" }],
      fingerprint: null,
      invocationId: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    });
    const command = await batch("rm file");
    await expect(command.execute()).rejects.toMatchObject({
      code: "execution_paused",
    });
    expect(dispatches).toHaveLength(1);
    const approval = store.execution.list("approvals", {
      runId: command.run.id,
    })[0];
    if (!approval) throw new Error("approval");
    expect(approval.command?.decision).toBe("prompt");
    expect(approval.resources).toHaveLength(0);
    expect(() =>
      tools.decide(approval.id, {
        requestId: "a",
        decision: "allow",
        scope: "workspace",
      }),
    ).toThrow("只允许本次");
    tools.decide(approval.id, {
      requestId: "a",
      decision: "allow",
      scope: "once",
    });
    store.execution.setRunStatus(command.run.id, "running");
    expect((await command.execute())?.[0]?.ok).toBe(true);
    await command.execute();
    expect(dispatches).toHaveLength(2);
    const next = await batch("rm file");
    await expect(next.execute()).rejects.toMatchObject({
      code: "execution_paused",
    });
    expect(dispatches).toHaveLength(2);
  });
  it("命令与跨界资源合并审批，拒绝回传工具错误且无派发", async () => {
    await mkdir(join(root, "outside"));
    const value = await batch("node script.js", {
      additionalPaths: [{ path: join(root, "outside"), access: "read" }],
    });
    await expect(value.execute()).rejects.toMatchObject({
      code: "execution_paused",
    });
    const approvals = store.execution.list("approvals", {
      runId: value.run.id,
    });
    expect(approvals).toHaveLength(1);
    const approval = approvals[0];
    if (!approval) throw new Error("approval");
    expect(approval.resources).toHaveLength(1);
    expect(approval.command).toBeTruthy();
    tools.decide(approval.id, {
      requestId: "no",
      decision: "deny",
      scope: "once",
    });
    store.execution.setRunStatus(value.run.id, "running");
    expect((await value.execute())?.[0]?.ok).toBe(false);
    expect(dispatches).toHaveLength(0);
  });
  it("规则改变使既有批准失效；等待锁后再次评估并创建新批准", async () => {
    const value = await batch("rm file");
    await expect(value.execute()).rejects.toMatchObject({
      code: "execution_paused",
    });
    const first = store.execution.list("approvals", { runId: value.run.id })[0];
    if (!first) throw new Error("approval");
    tools.decide(first.id, {
      requestId: "yes",
      decision: "allow",
      scope: "once",
    });
    store.execution.setRunStatus(value.run.id, "running");
    let changed = false;
    value.input.onUpdate = async (_index, status) => {
      if (status === "queued" && !changed) {
        changed = true;
        await save([{ id: "rm", pattern: ["rm"], decision: "prompt" }]);
      }
    };
    await expect(value.execute()).rejects.toMatchObject({
      code: "execution_paused",
    });
    expect(dispatches).toHaveLength(0);
    const pending = store.execution
      .list("approvals", { runId: value.run.id })
      .filter((a) => a.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.command?.binding).not.toBe(first.command?.binding);
  });
  it("Worker 准备期间规则收紧，accepted 前拒绝且没有真实派发", async () => {
    const value = await batch("pwd");
    acceptedHook = async () => {
      await save([{ id: "pwd", pattern: ["pwd"], decision: "deny" }]);
    };
    const result = await value.execute();
    expect(result?.[0]?.ok).toBe(false);
    expect(result?.[0]?.error?.code).toBe("command_policy_changed");
    expect(dispatches).toHaveLength(0);
    expect(
      store.execution.list("attempts", { runId: value.run.id })[0]?.status,
    ).toBe("completed");
  });
  it("Worker 准备期间撤销本次命令批准，不能用空资源集合继续派发", async () => {
    const value = await batch("rm file");
    await expect(value.execute()).rejects.toMatchObject({
      code: "execution_paused",
    });
    const approval = store.execution.list("approvals", {
      runId: value.run.id,
    })[0];
    if (!approval) throw new Error("approval");
    tools.decide(approval.id, {
      requestId: "yes",
      decision: "allow",
      scope: "once",
    });
    store.execution.setRunStatus(value.run.id, "running");
    acceptedHook = async () => {
      const grant = store.execution.get("grants", approval.id);
      if (!grant) throw new Error("grant");
      store.execution.put("grants", {
        ...grant,
        revokedAt: new Date().toISOString(),
      });
    };
    expect((await value.execute())?.[0]?.error?.code).toBe(
      "command_policy_changed",
    );
    expect(dispatches).toHaveLength(0);
  });
  it("批准后参数或目录改变需要新审批，解析端口失效不能降级", async () => {
    const value = await batch("rm file");
    await expect(value.execute()).rejects.toMatchObject({
      code: "execution_paused",
    });
    const approval = store.execution.list("approvals", {
      runId: value.run.id,
    })[0];
    if (!approval) throw new Error("approval");
    tools.decide(approval.id, {
      requestId: "yes",
      decision: "allow",
      scope: "once",
    });
    store.execution.setRunStatus(value.run.id, "running");
    await mkdir(join(work, "sub"));
    value.input.calls = [
      {
        id: "command",
        name: "exec_command",
        arguments: JSON.stringify({ command: "rm other", cwd: "sub" }),
      },
    ];
    await expect(value.execute()).rejects.toMatchObject({
      code: "execution_paused",
    });
    expect(dispatches).toHaveLength(0);
    const pending = store.execution
      .list("approvals")
      .findLast((item) => item.status === "pending");
    expect(pending?.command?.cwd).toBe(join(work, "sub"));
    expect(pending?.command?.binding).not.toBe(approval.command?.binding);
    tools.options.commands = new CommandPolicyService(
      store.execution,
      files,
      {
        async analyze() {
          throw new Error("parser failed");
        },
      },
      paths,
    );
    const other = await batch("pwd");
    expect((await other.execute())?.[0]?.ok).toBe(false);
    expect(dispatches).toHaveLength(0);
  });
  it("没有命令权限端口时拒绝执行，不静默退回只有资源检查", async () => {
    delete tools.options.commands;
    const value = await batch("pwd");
    expect((await value.execute())?.[0]?.error?.code).toBe(
      "command_policy_unavailable",
    );
    expect(dispatches).toHaveLength(0);
  });
});
