/** Hook 工程验证：真实文件/SQLite，受控网关替身核验生命周期；原生隔离在 native 专项单独验收。 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import { LocalHookFiles } from "../../packages/adapters/src/index.js";
import type {
  HookDefinition,
  HookEvent,
  HookInput,
} from "../../packages/contracts/src/index.js";
import {
  parseHookDocument,
  parseHookOutput,
} from "../../packages/extensions/src/index.js";
import type {
  ModelMessage,
  ModelPort,
} from "../../packages/kernel/src/index.js";

const roots: string[] = [];
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let files: LocalHookFiles | undefined;
afterEach(async () => {
  if (app) await app.server.close();
  app = undefined;
  files?.packages.collect(new Set());
  files = undefined;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const done = (content = "完成") => ({
  type: "done" as const,
  finishReason: "stop",
  usage: null,
  response: { content, toolCalls: [] },
});
const direct: ModelPort = {
  async *stream() {
    yield done();
  },
};
async function setup(model = direct) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "myagent-hooks-")));
  roots.push(root);
  const pkg = join(root, "package");
  mkdirSync(pkg);
  writeFileSync(
    join(pkg, "main.mjs"),
    'console.log(JSON.stringify({decision:"continue"}));',
  );
  app = await buildServer({
    dataDir: join(root, "data"),
    workspaceRoot: join(root, "work"),
    skillRoot: join(root, "skills"),
    serveWeb: false,
    modelFactory: () => model,
  });
  app.settings.save({
    baseUrl: "http://127.0.0.1:1/v1",
    apiProtocol: "responses",
    model: "fixture",
    apiKey: "private-test-key",
    systemPrompt: "",
    expectedRevision: 0,
  });
  const session = await app.projects.create({ requestId: crypto.randomUUID() });
  files = new LocalHookFiles(join(root, "data"), app.store.execution);
  return { root, pkg, session };
}
const definition = (
  pkg: string,
  event: HookEvent,
  id: string = event,
): HookDefinition => ({
  id,
  event,
  enabled: true,
  packagePath: pkg,
  entry: "main.mjs",
  interpreter: "node",
  args: [],
  timeoutMs: 2000,
  permissions: { writePaths: [], networkDomains: [] },
});
async function config(hooks: HookDefinition[], workspaceId?: string) {
  const target = workspaceId
    ? { scope: "project" as const, workspaceId }
    : { scope: "user" as const };
  const before = app!.hooks.view(target),
    text = JSON.stringify({ schemaVersion: 1, hooks });
  const preview = await app!.hooks.save({
    ...target,
    text,
    expectedRevision: before.revision,
  });
  expect(preview.error).toBeNull();
  return app!.hooks.save({
    ...target,
    text,
    expectedRevision: before.revision,
    expectedVersion: preview.version,
  });
}
function mockHooks(
  handler: (input: HookInput) => unknown = () => ({ decision: "continue" }),
) {
  const gateway = app!.toolSystem.options.gateway,
    original = gateway.dispatch.bind(gateway),
    inputs: HookInput[] = [];
  vi.spyOn(gateway, "dispatch").mockImplementation(async (request, signal) => {
    if (!request.hook) return original(request, signal);
    const input = request.hook.input as unknown as HookInput;
    inputs.push(input);
    await request.onAccepted?.("fixture-worker");
    const output = handler(input);
    return {
      attemptId: request.attemptId,
      invocationId: request.context.invocationId,
      outcome: "succeeded",
      data: {
        stdout: typeof output === "string" ? output : JSON.stringify(output),
      },
      error: null,
      effectsPossible: false,
      completedAt: new Date().toISOString(),
    };
  });
  return inputs;
}
async function start(sessionId: string) {
  const session = app!.store.snapshot(sessionId).session;
  const accepted = app!.chat.start(session.id, {
    requestId: crypto.randomUUID(),
    expectedRevision: session.revision,
    content: "请检查项目",
  });
  await expect
    .poll(() => app!.store.getRun(accepted.run.id).status, { timeout: 10000 })
    .not.toMatch(/^(queued|running|cleaning)$/);
  return app!.store.getRun(accepted.run.id);
}
it("配置和输出严格校验：精确工具名、未知字段、拒绝和结束上下文边界", () => {
  const d = definition("/tmp/pkg", "PreToolUse");
  expect(
    parseHookDocument(
      JSON.stringify({
        schemaVersion: 1,
        hooks: [{ ...d, tools: ["read_file"] }],
      }),
    ).hooks[0]!.tools,
  ).toEqual(["read_file"]);
  expect(() => parseHookOutput('{"decision":"deny"}', "PreToolUse")).toThrow();
  expect(() =>
    parseHookOutput('{"decision":"deny","reason":"x"}', "PostToolUse"),
  ).toThrow();
  expect(() =>
    parseHookOutput(
      '{"decision":"continue","additionalContext":"x"}',
      "RunEnd",
    ),
  ).toThrow();
  expect(() =>
    parseHookOutput('{"decision":"continue","approve":true}', "RunStart"),
  ).toThrow();
  expect(() =>
    parseHookDocument(
      JSON.stringify({
        schemaVersion: 1,
        hooks: [
          {
            ...d,
            permissions: { writePaths: ["../private"], networkDomains: [] },
          },
        ],
      }),
    ),
  ).toThrow();
  expect(() =>
    parseHookDocument(
      JSON.stringify({
        schemaVersion: 1,
        hooks: [
          {
            ...d,
            permissions: { writePaths: [], networkDomains: ["*.example.com"] },
          },
        ],
      }),
    ),
  ).toThrow();
  expect(parseHookOutput("", "RunEnd")).toEqual({ decision: "continue" });
});
it("配置预览不授权、不创建会话；保存准确版本，外部修改或删除阻止新 Run", async () => {
  const { root, pkg, session } = await setup();
  const before = app!.hooks.view({ scope: "user" }),
    text = JSON.stringify({
      schemaVersion: 1,
      hooks: [definition(pkg, "RunStart")],
    });
  const preview = await app!.hooks.save({
    scope: "user",
    text,
    expectedRevision: before.revision,
  });
  expect(app!.store.listSessions()).toHaveLength(1);
  expect(app!.hooks.view({ scope: "user" }).document?.hooks).toHaveLength(0);
  await app!.hooks.save({
    scope: "user",
    text,
    expectedRevision: before.revision,
    expectedVersion: preview.version,
  });
  writeFileSync(join(pkg, "main.mjs"), 'console.log("changed")');
  expect(app!.hooks.view({ scope: "user" }).blocking).toBe(true);
  expect(() =>
    app!.chat.start(session.id, {
      requestId: crypto.randomUUID(),
      expectedRevision: session.revision,
      content: "x",
    }),
  ).toThrow(/确认/);
  expect(app!.store.snapshot(session.id).messages).toHaveLength(0);
  rmSync(join(root, "data/hooks.json"));
  expect(app!.hooks.view({ scope: "user" }).blocking).toBe(true);
});
it("保存检测包竞态、文件并发和非法 JSON，保留有效授权与错误原文", async () => {
  const { root, pkg } = await setup();
  await config([definition(pkg, "RunStart")]);
  const before = app!.hooks.view({ scope: "user" });
  writeFileSync(join(root, "data/hooks.json"), "{bad json");
  const bad = app!.hooks.view({ scope: "user" });
  expect(bad.error).toBeTruthy();
  expect(bad.text).toBe("{bad json");
  expect(bad.blocking).toBe(true);
  await expect(
    app!.hooks.save({
      scope: "user",
      text: before.text,
      expectedRevision: before.revision,
      expectedVersion: before.version,
    }),
  ).rejects.toThrow(/变化/);
});
it("四事件及双作用域顺序，补充上下文、无递归、Hook 不增加模型请求数", async () => {
  const requests: readonly ModelMessage[][] = [] as ModelMessage[][];
  const model: ModelPort = {
    async *stream(messages) {
      (requests as ModelMessage[][]).push([...messages]);
      if (messages.some((m) => m.role === "tool")) {
        yield done();
        return;
      }
      yield {
        type: "done",
        finishReason: "tool_calls",
        usage: null,
        response: {
          content: "查时间",
          toolCalls: [
            { id: "clock", name: "get_current_time", arguments: "{}" },
          ],
        },
      };
    },
  };
  const { pkg, session } = await setup(model),
    workspace = app!.toolSystem.workspace(session.id)!;
  await config([
    definition(pkg, "RunStart"),
    definition(pkg, "PreToolUse"),
    definition(pkg, "PostToolUse"),
    definition(pkg, "RunEnd"),
  ]);
  await config([definition(pkg, "PreToolUse", "project")], workspace.id);
  const inputs = mockHooks((input) =>
    input.event === "RunEnd"
      ? { decision: "continue" }
      : { decision: "continue", additionalContext: `context-${input.event}` },
  );
  const run = await start(session.id);
  expect(run.status).toBe("succeeded");
  expect(run.stepCount).toBe(2);
  expect(inputs.map((i) => i.event)).toEqual([
    "RunStart",
    "PreToolUse",
    "PreToolUse",
    "PostToolUse",
    "RunEnd",
  ]);
  expect(JSON.stringify(requests[0])).toContain("context-RunStart");
  expect(JSON.stringify(requests[1])).toContain("context-PostToolUse");
  expect(app!.hooks.records(session.id)).toHaveLength(5);
  expect(app!.store.getSteps(run.id)).toHaveLength(2);
  expect(
    app!.store
      .events(session.id, 0)
      .filter((e) => e.type === "hook.updated")
      .every((e) => e.schemaVersion === 5),
  ).toBe(true);
  expect(JSON.stringify(inputs)).not.toContain("private-test-key");
  const history = app!.store.context.history(session.id, {
    query: "context-PostToolUse",
  });
  expect(history.entries.some((e) => e.kind === "hook")).toBe(true);
});
it("前置拒绝没有业务派发和后置事件，模型收到拒绝后可自行结束", async () => {
  const model: ModelPort = {
    async *stream(messages) {
      if (messages.some((m) => m.role === "tool")) {
        expect(JSON.stringify(messages)).toContain("禁止此动作");
        yield done();
        return;
      }
      yield {
        type: "done",
        finishReason: "tool_calls",
        usage: null,
        response: {
          content: "",
          toolCalls: [{ id: "t", name: "get_current_time", arguments: "{}" }],
        },
      };
    },
  };
  const { pkg, session } = await setup(model);
  await config([definition(pkg, "PreToolUse"), definition(pkg, "PostToolUse")]);
  const inputs = mockHooks(() => ({ decision: "deny", reason: "禁止此动作" }));
  const run = await start(session.id);
  expect(run.status).toBe("succeeded");
  expect(inputs.map((i) => i.event)).toEqual(["PreToolUse"]);
  expect(
    app!.store.execution
      .list("attempts", { runId: run.id })
      .every((a) => a.origin === "hook"),
  ).toBe(true);
});
it("开始故障不请求模型；后置/结束故障保留业务结果并展示警告", async () => {
  let count = 0;
  const model: ModelPort = {
    async *stream() {
      count++;
      yield done();
    },
  };
  const { pkg, session } = await setup(model);
  await config([definition(pkg, "RunStart")]);
  mockHooks(() => "invalid json");
  expect((await start(session.id)).status).toBe("failed");
  expect(count).toBe(0);
  vi.restoreAllMocks();
  await config([definition(pkg, "RunEnd")]);
  mockHooks(() => "invalid json");
  const run = await start(session.id);
  expect(run.status).toBe("succeeded");
  expect(count).toBe(1);
  expect(
    app!.hooks.records(session.id).find((r) => r.runId === run.id)?.status,
  ).toBe("failed");
});
it("Hook 快照资源只读；原生网关收到的权限未包含工作区默认写入", async () => {
  const { pkg, session } = await setup();
  await config([definition(pkg, "RunStart")]);
  mockHooks();
  const run = await start(session.id);
  const record = app!.store.hooks.list("events", { runId: run.id })[0]!;
  expect(record.resources.every((r) => r.access === "read")).toBe(true);
  const frozen = app!.store.hooks.get("runs", run.id)!.hooks[0]!;
  expect(
    readFileSync(join(frozen.package.runtimePath, "main.mjs"), "utf8"),
  ).toContain("continue");
});
it("工具批次有匹配 Hook 时按模型顺序串行，无匹配时保留并发", async () => {
  const model: ModelPort = {
    async *stream(messages) {
      if (messages.some((m) => m.role === "tool")) {
        yield done();
        return;
      }
      yield {
        type: "done",
        finishReason: "tool_calls",
        usage: null,
        response: {
          content: "",
          toolCalls: [
            { id: "a", name: "get_current_time", arguments: "{}" },
            {
              id: "b",
              name: "get_current_time",
              arguments: '{"timezone":"Asia/Shanghai"}',
            },
          ],
        },
      };
    },
  };
  const { pkg, session } = await setup(model),
    order: string[] = [];
  await config([definition(pkg, "PreToolUse"), definition(pkg, "PostToolUse")]);
  const gateway = app!.toolSystem.options.gateway,
    original = gateway.dispatch.bind(gateway);
  vi.spyOn(gateway, "dispatch").mockImplementation(async (r, s) => {
    if (!r.hook) {
      order.push(`tool:${r.prepared.arguments.timezone ?? "UTC"}`);
      return original(r, s);
    }
    const i = r.hook.input as unknown as HookInput;
    await r.onAccepted?.("fixture");
    order.push(
      `${i.event}:${(i.tool!.arguments as { timezone?: string }).timezone ?? "UTC"}`,
    );
    return {
      attemptId: r.attemptId,
      invocationId: r.context.invocationId,
      outcome: "succeeded",
      data: { stdout: "" },
      error: null,
      effectsPossible: false,
      completedAt: new Date().toISOString(),
    };
  });
  expect((await start(session.id)).status).toBe("succeeded");
  expect(order).toEqual([
    "PreToolUse:UTC",
    "tool:UTC",
    "PostToolUse:UTC",
    "PreToolUse:Asia/Shanghai",
    "tool:Asia/Shanghai",
    "PostToolUse:Asia/Shanghai",
  ]);
  // 匹配不使用字符串前缀，工具名数组也不会扩大到其它工具。
  await config([{ ...definition(pkg, "PreToolUse"), tools: ["get_current"] }]);
  order.length = 0;
  const fresh = await app!.projects.create({ requestId: crypto.randomUUID() });
  expect((await start(fresh.id)).status).toBe("succeeded");
  expect(order).toEqual(["tool:UTC", "tool:Asia/Shanghai"]);
});
it("停止不启动 RunEnd，迟到 Hook 回执不能注入上下文", async () => {
  const { pkg, session } = await setup();
  await config([definition(pkg, "RunStart"), definition(pkg, "RunEnd")]);
  const gateway = app!.toolSystem.options.gateway;
  let finish:
    | ((value: Awaited<ReturnType<typeof gateway.dispatch>>) => void)
    | undefined;
  vi.spyOn(gateway, "dispatch").mockImplementation(async (r) => {
    await r.onAccepted?.("fixture");
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const accepted = app!.chat.start(session.id, {
    requestId: crypto.randomUUID(),
    expectedRevision: session.revision,
    content: "停止测试",
  });
  await expect.poll(() => Boolean(finish)).toBe(true);
  await app!.chat.cancel(accepted.run.id);
  const record = app!.store.hooks.list("events", {
    runId: accepted.run.id,
  })[0]!;
  finish!({
    attemptId: record.attemptId!,
    invocationId: record.id,
    outcome: "succeeded",
    data: {
      stdout: '{"decision":"continue","additionalContext":"LATE_SECRET"}',
    },
    error: null,
    effectsPossible: false,
    completedAt: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(app!.hooks.records(session.id).map((r) => r.event)).toEqual([
    "RunStart",
  ]);
  expect(app!.hooks.startMessages(accepted.run.id)).toEqual([]);
});
it("已落盘未投影的配置提交日志恢复，包变更不会被日志误确认", async () => {
  const { pkg, root } = await setup();
  const before = app!.hooks.view({ scope: "user" }),
    text = JSON.stringify({
      schemaVersion: 1,
      hooks: [definition(pkg, "RunStart")],
    });
  const prepared = files!.inspect({ scope: "user" }, text);
  await files!.capture(prepared.hooks, new AbortController().signal);
  app!.store.hooks.put("files", {
    id: "user",
    target: { scope: "user" },
    trustedVersion: null,
    trustedHooks: [],
    staged: { text, version: prepared.version, hooks: prepared.hooks },
  });
  await files!.write({ scope: "user" }, text, before.revision);
  expect(app!.hooks.view({ scope: "user" }).pending).toBe(false);
  expect(app!.store.hooks.get("files", "user")?.staged).toBeUndefined();
  writeFileSync(join(pkg, "main.mjs"), 'console.log("changed")');
  expect(app!.hooks.view({ scope: "user" }).blocking).toBe(true);
  expect(readFileSync(join(root, "data/hooks.json"), "utf8")).toBe(text);
});
it("重启回执核对不重放；恢复完成的启动结果，不重新调用脚本", async () => {
  const { pkg, session } = await setup();
  await config([definition(pkg, "RunStart")]);
  const inputs = mockHooks(() => ({
    decision: "continue",
    additionalContext: "SAVED_START",
  }));
  const run = app!.store.beginRun({
    sessionId: session.id,
    expectedRevision: session.revision,
    requestId: "recovery",
    fingerprint: "recovery",
    kind: "send",
    content: "recover",
    model: "fixture",
    contextTrimmed: false,
  });
  app!.hooks.initialize(run);
  await app!.hooks.trigger(
    run.id,
    "RunStart",
    "start",
    new AbortController().signal,
  );
  expect(inputs).toHaveLength(1);
  await app!.hooks.recover();
  await app!.hooks.trigger(
    run.id,
    "RunStart",
    "start",
    new AbortController().signal,
  );
  expect(inputs).toHaveLength(1);
  const record = app!.store.hooks.list("events", { runId: run.id })[0]!;
  record.status = "running";
  record.applied = false;
  record.output = null;
  app!.store.hooks.put("events", record);
  await app!.hooks.recover();
  expect(app!.store.hooks.get("events", record.id)?.status).toBe("unknown");
  await expect(
    app!.hooks.trigger(
      run.id,
      "RunStart",
      "start",
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "execution_paused" });
  expect(inputs).toHaveLength(1);
});
it("已确定成功/失败的 cleaning 恢复不再次调用模型，结束 Hook 不重放", async () => {
  let calls = 0;
  const model: ModelPort = {
    async *stream() {
      calls++;
      yield done();
    },
  };
  const { root, pkg, session } = await setup(model);
  await config([definition(pkg, "RunEnd")]);
  const inputs = mockHooks();
  const accepted = app!.chat.start(session.id, {
    requestId: crypto.randomUUID(),
    expectedRevision: session.revision,
    content: "收尾恢复",
  });
  await expect
    .poll(() => app!.store.getRun(accepted.run.id).status)
    .toBe("succeeded");
  expect(calls).toBe(1);
  expect(inputs).toHaveLength(1);
  // 模拟最终状态提交前崩溃：保留完成 Step/Hook 与待提交结果，只恢复持久运行状态。
  const db = new DatabaseSync(join(root, "data/state.db"));
  db.prepare(
    "UPDATE runs SET status='recoverable', data=json_set(data,'$.status','recoverable') WHERE id=?",
  ).run(accepted.run.id);
  db.close();
  await app!.chat.resume(accepted.run.id);
  await expect
    .poll(() => app!.store.getRun(accepted.run.id).status)
    .toBe("succeeded");
  expect(calls).toBe(1);
  expect(inputs).toHaveLength(1);
});
it("大补充信息保留头尾与引用，全文通过原结果读取，stdout 64 KiB 协议独立限制", async () => {
  const { pkg, session } = await setup();
  await config([definition(pkg, "RunStart")]);
  const content = "BEGIN_中文" + "长".repeat(14000) + "END_尾部";
  mockHooks(() => ({ decision: "continue", additionalContext: content }));
  const run = await start(session.id);
  expect(run.status).toBe("succeeded");
  const record = app!.hooks.records(session.id)[0]!;
  expect(record.output!.additionalContext!.length).toBeLessThanOrEqual(8000);
  expect(record.output!.additionalContext).toContain("BEGIN_中文");
  expect(record.output!.additionalContext).toContain("END_尾部");
  expect(record.output!.additionalContext).toContain(record.resultRef!);
  let cursor: string | undefined,
    raw = "";
  do {
    const page = await app!.toolSystem.options.results.read(
      record.resultRef!,
      session.id,
      cursor,
      8000,
    );
    raw += page.text;
    cursor = page.cursor ?? undefined;
  } while (cursor);
  expect(raw).toContain(content);
  expect(() =>
    parseHookOutput(
      JSON.stringify({
        decision: "continue",
        additionalContext: "中".repeat(23000),
      }),
      "RunStart",
    ),
  ).toThrow(/64 KiB/);
});
it("执行意图写入失败暂停恢复，不按普通 Hook 故障继续启动收尾或模型", async () => {
  let calls = 0;
  const model: ModelPort = {
    async *stream() {
      calls++;
      yield done();
    },
  };
  const { root, pkg, session } = await setup(model);
  await config([definition(pkg, "RunStart"), definition(pkg, "RunEnd")]);
  const inputs = mockHooks();
  const db = new DatabaseSync(join(root, "data/state.db"));
  db.exec(
    "CREATE TRIGGER hook_failure BEFORE INSERT ON hook_records WHEN NEW.kind='events' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;",
  );
  try {
    const run = await start(session.id);
    expect(run.status).toBe("recoverable");
    expect(calls).toBe(0);
    expect(inputs).toHaveLength(0);
  } finally {
    db.exec("DROP TRIGGER hook_failure");
    db.close();
  }
});
it("收尾意图存储失败保留成功业务结果，修复后只继续未执行 Hook", async () => {
  let calls = 0;
  const model: ModelPort = {
    async *stream() {
      calls++;
      yield done("原答案");
    },
  };
  const { root, pkg, session } = await setup(model);
  await config([definition(pkg, "RunEnd")]);
  const inputs = mockHooks();
  const db = new DatabaseSync(join(root, "data/state.db"));
  db.exec(
    "CREATE TRIGGER end_failure BEFORE INSERT ON hook_records WHEN NEW.kind='events' AND json_extract(NEW.data,'$.event')='RunEnd' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;",
  );
  let run: Awaited<ReturnType<typeof start>>;
  try {
    run = await start(session.id);
    expect(run.status).toBe("recoverable");
    expect(app!.hooks.pendingEnd(run.id)?.status).toBe("succeeded");
    expect(inputs).toHaveLength(0);
    expect(calls).toBe(1);
  } finally {
    db.exec("DROP TRIGGER end_failure");
    db.close();
  }
  await app!.chat.resume(run!.id);
  await expect.poll(() => app!.store.getRun(run!.id).status).toBe("succeeded");
  expect(inputs).toHaveLength(1);
  expect(calls).toBe(1);
  expect(app!.store.snapshot(session.id).messages.at(-1)?.content).toBe(
    "原答案",
  );
});
it("Worker 拒绝派发不能触发后置 Hook", async () => {
  const { AppError } = await import("../../packages/contracts/src/index.js");
  const model: ModelPort = {
    async *stream(messages) {
      if (messages.some((m) => m.role === "tool")) {
        yield done();
        return;
      }
      yield {
        type: "done",
        finishReason: "tool_calls",
        usage: null,
        response: {
          content: "",
          toolCalls: [
            {
              id: "denied-dispatch",
              name: "get_current_time",
              arguments: "{}",
            },
          ],
        },
      };
    },
  };
  const { pkg, session } = await setup(model);
  await config([definition(pkg, "PostToolUse")]);
  let hookCalls = 0;
  vi.spyOn(app!.toolSystem.options.gateway, "dispatch").mockImplementation(
    async (r) => {
      if (r.hook) hookCalls++;
      throw new AppError("sandbox_unavailable", "测试环境拒绝派发。");
    },
  );
  const run = await start(session.id);
  expect(run.status).toBe("succeeded");
  expect(hookCalls).toBe(0);
  expect(app!.hooks.records(session.id)).toEqual([]);
});
