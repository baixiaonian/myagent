/**
 * 大结果反馈回归：验证真实原文首尾、序列化后的硬预算、状态保留和受控补读。
 * 使用临时 SQLite/结果文件及无网络模型；不代表真实模型对预览内容的理解质量。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import {
  FileResultStore,
  SqliteChatStore,
} from "../../packages/adapters/src/index.js";
import { ContextService } from "../../packages/application/src/index.js";
import {
  AGENT_LIMITS,
  AppError,
  type JsonValue,
} from "../../packages/contracts/src/index.js";
import {
  type ContextInput,
  createToolPreview,
  type ModelPort,
  type ResultStorePort,
} from "../../packages/kernel/src/index.js";
import { mockProvider } from "../chat/provider.js";

let root: string;
let store: SqliteChatStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "myagent-result-preview-"));
  store = new SqliteChatStore(":memory:");
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});
function fixture() {
  const session = store.createSession();
  const run = store.beginRun({
    sessionId: session.id,
    requestId: "preview",
    expectedRevision: 0,
    fingerprint: "preview",
    kind: "send",
    content: "检查日志",
    model: "fixture",
    contextTrimmed: false,
  });
  const results = new FileResultStore(root, store.execution);
  const context = {
    sessionId: session.id,
    runId: run.id,
    stepId: "step",
    invocationId: "call",
    workspace: null,
  };
  let summaries = 0;
  const model: ModelPort = {
    // 人为以字符数估算，让 8k 预览超限、512 预览可容纳，从而单独检验二次缩减。
    estimateInput: (messages) =>
      messages.reduce((n, m) => n + m.content.length, 0),
    async *stream() {
      summaries++;
      yield { type: "text", text: "测试摘要" };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
  const service = (source: ResultStorePort = results) => {
    const s = new ContextService(
      store.context,
      store,
      store.execution,
      { read: () => null },
      () => "",
      undefined,
      0.8,
      source,
    );
    s.initialize(run, {
      ...store.settings(),
      contextWindowTokens: 8192,
      outputReserveTokens: 1024,
    });
    return s;
  };
  const input = (ref: string, text: string): ContextInput => ({
    instructions: "",
    history: [],
    tools: [],
    limits: { ...AGENT_LIMITS },
    current: [
      { role: "user", sourceId: run.userMessageId, content: "检查日志" },
      {
        role: "assistant",
        sourceId: "step",
        content: "",
        toolCalls: [{ id: "call", name: "logs", arguments: "{}" }],
      },
      {
        role: "tool",
        sourceId: "step/tool/call",
        callId: "call",
        content: text,
        resultInfo: { resultRef: ref, outcome: "failed" },
      },
    ],
  });
  return {
    session,
    run,
    results,
    context,
    model,
    service,
    input,
    summaries: () => summaries,
  };
}

it("普通文本保持原样，边界内不额外包装", () => {
  expect(createToolPreview("完整内容", 4)).toEqual({
    content: "完整内容",
    truncated: false,
  });
  expect(createToolPreview("", 1)).toEqual({ content: "", truncated: false });
});

it("最终 JSON 包含真实头尾、中间标记和引用，转义与 emoji 不突破预算", () => {
  const text = `HEAD\n${'引号"\\\n😀'.repeat(3000)}\nTAIL`;
  for (const maximum of [160, 511, 8000]) {
    const output = createToolPreview(text, maximum, {
      reference: "read_tool_result resultId=ref",
    });
    expect(output.truncated).toBe(true);
    expect(output.content.length).toBeLessThanOrEqual(maximum);
    const { preview } = JSON.parse(output.content) as { preview: string };
    expect(preview).toMatch(/^HEAD/);
    expect(preview).toMatch(/TAIL$/);
    expect(preview).toContain("中间已截断");
    expect(preview).toContain("read_tool_result resultId=ref");
    expect(Buffer.from(preview).toString("utf8")).toBe(preview);
  }
});

it("原始结果持久保存，8k 和 512 预览都保留尾部报错、状态和完整引用", async () => {
  const f = fixture();
  const value = {
    outcome: "failed",
    data: {
      processId: "process",
      status: "exited",
      exitCode: 7,
      output: `HEAD_LOG${"日志".repeat(10000)}TAIL_ERROR`,
    },
    error: { code: "exit", message: "命令以非零状态结束" },
    effectsPossible: true,
  };
  const saved = await f.results.save(f.context, value);
  expect(saved.preview.length).toBeLessThanOrEqual(8000);
  expect(saved.preview).toContain("HEAD_LOG");
  expect(saved.preview).toContain("TAIL_ERROR");
  const small = await f.results.preview(saved.reference.id, f.session.id, 512);
  expect(small.content.length).toBeLessThanOrEqual(512);
  expect(small.content).toContain("TAIL_ERROR");
  expect(JSON.parse(small.content).execution).toMatchObject({
    outcome: "failed",
    status: "exited",
    exitCode: 7,
    error: value.error,
  });
  expect(
    await readFile(join(f.results.root, `${saved.reference.id}.txt`), "utf8"),
  ).toBe(JSON.stringify(value));
  await expect(
    f.results.preview(saved.reference.id, "other-session", 512),
  ).rejects.toMatchObject({ code: "not_found" });
});

it("上下文二次缩减从原文取头尾，兼容旧的仅头部预览且不改写历史", async () => {
  const f = fixture();
  const saved = await f.results.save(f.context, {
    outcome: "succeeded",
    data: { text: `ORIGINAL_HEAD${"中间日志".repeat(10000)}ORIGINAL_TAIL` },
    error: null,
  });
  const input = f.input(saved.reference.id, `${"旧头部".repeat(1990)}[已截断]`);
  const original = JSON.stringify(input);
  const prepared = await f
    .service()
    .forRun(f.run, f.model)
    .prepare?.(input, new AbortController().signal);
  const content = prepared?.messages.at(-1)?.content ?? "";
  expect(content.length).toBeLessThanOrEqual(512);
  expect(content).toContain("ORIGINAL_HEAD");
  expect(content).toContain("ORIGINAL_TAIL");
  expect(content).not.toContain("旧头部");
  expect(f.summaries()).toBe(0);
  expect(JSON.stringify(input)).toBe(original);
  expect(store.context.list("manifests", f.session.id)).toHaveLength(1);
});

it("重新投影不会把 MCP 二进制附件发给模型，保存文件仍保留附件", async () => {
  const f = fixture();
  const value: JsonValue = {
    outcome: "succeeded",
    data: {
      content: [
        { type: "text", text: `HEAD${"信息".repeat(10000)}TAIL` },
        { type: "image", mimeType: "image/png", data: "BINARY_IMAGE_CANARY" },
        {
          type: "resource",
          resource: { uri: "fixture://blob", blob: "BINARY_RESOURCE_CANARY" },
        },
      ],
    },
    error: null,
  };
  const saved = await f.results.save(f.context, value);
  const view = await f.results.preview(saved.reference.id, f.session.id, 8000);
  expect(view.content).not.toContain("BINARY_IMAGE_CANARY");
  expect(view.content).not.toContain("BINARY_RESOURCE_CANARY");
  expect(view.content).toContain("TAIL");
  expect(
    await readFile(join(f.results.root, `${saved.reference.id}.txt`), "utf8"),
  ).toContain("BINARY_IMAGE_CANARY");
});

it("预算连固定信息都放不下时暂停，不删掉执行状态或重新执行工具", async () => {
  const f = fixture();
  const saved = await f.results.save(f.context, {
    outcome: "failed",
    data: "内容".repeat(5000),
    error: { code: "exit", message: "已执行但失败" },
  });
  const input = f.input(saved.reference.id, saved.preview);
  input.limits.toolResultCharacters = 10;
  await expect(
    f
      .service()
      .forRun(f.run, f.model)
      .prepare?.(input, new AbortController().signal),
  ).rejects.toMatchObject({ code: "execution_paused" });
  expect(store.getRun(f.run.id).status).toBe("waiting_context");
  expect(f.summaries()).toBe(0);
});

it("真实应用保存执行成功事实后因极小预算暂停，不把已执行动作记成 unknown", async () => {
  let dispatched = 0;
  let requested = 0;
  const app = await buildServer({
    dataDir: join(root, "tiny-budget"),
    workspaceRoot: join(root, "workspaces"),
    serveWeb: false,
    agentLimits: { toolResultCharacters: 10 },
    modelFactory: () => ({
      async *stream() {
        requested++;
        yield {
          type: "done",
          finishReason: "tool_calls",
          usage: null,
          response: {
            content: "",
            toolCalls: [
              { id: "call", name: "get_current_time", arguments: "{}" },
            ],
          },
        };
      },
    }),
  });
  try {
    app.gateway.dispatch = async (request) => {
      dispatched++;
      await request.onAccepted?.(null);
      return {
        attemptId: request.attemptId,
        invocationId: request.context.invocationId,
        outcome: "succeeded",
        data: { text: "可靠的执行结果" },
        error: null,
        effectsPossible: false,
        completedAt: new Date().toISOString(),
      };
    };
    app.settings.save({
      baseUrl: "http://127.0.0.1:1/v1",
      apiProtocol: "responses",
      model: "fixture",
      apiKey: "fixture-only",
      systemPrompt: "",
      expectedRevision: 0,
    });
    const session = app.store.createSession();
    const { run } = app.chat.start(session.id, {
      requestId: "tiny",
      expectedRevision: 0,
      content: "查询时间",
    });
    await expect
      .poll(() => app.store.getRun(run.id).status)
      .toBe("waiting_context");
    const invocation = app.store.execution.list("invocations", {
      runId: run.id,
    })[0];
    expect(invocation?.status).toBe("succeeded");
    expect(invocation?.result?.resultRef).toBeTruthy();
    expect(dispatched).toBe(1);
    expect(requested).toBe(1);
  } finally {
    await app.server.close();
  }
});

it("读取原始预览期间停止，不合作的迟到返回不能提交上下文清单", async () => {
  const f = fixture();
  const controller = new AbortController();
  let release = (_value: { content: string; truncated: boolean }) => {};
  let started = false;
  f.results.preview = () =>
    new Promise((resolve) => {
      started = true;
      release = resolve;
    });
  const pending = f
    .service()
    .forRun(f.run, f.model)
    .prepare?.(f.input("ref", "大结果".repeat(5000)), controller.signal);
  await expect.poll(() => started).toBe(true);
  controller.abort(new AppError("cancelled", "测试停止"));
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  release({ content: "迟到预览", truncated: true });
  expect(store.context.list("manifests", f.session.id)).toHaveLength(0);
});

it.each(["responses", "chat_completions"] as const)(
  "%s 实际 HTTP 请求收到首尾和执行事实，结果补读保持原文",
  async (apiProtocol) => {
    const provider = await mockProvider(0, (_question, results) => ({
      calls: results.length
        ? []
        : [{ id: "output-call", name: "get_current_time", arguments: "{}" }],
      text: results.length ? "已读取首尾预览" : "",
    }));
    const app = await buildServer({
      dataDir: join(root, "server"),
      workspaceRoot: join(root, "workspaces"),
      serveWeb: false,
    });
    try {
      const value = { text: `HTTP_HEAD${'中间\n"内容'.repeat(5000)}HTTP_TAIL` };
      app.gateway.dispatch = async (request) => {
        await request.onAccepted?.(null);
        return {
          attemptId: request.attemptId,
          invocationId: request.context.invocationId,
          outcome: "succeeded",
          data: value,
          error: null,
          effectsPossible: false,
          completedAt: new Date().toISOString(),
        };
      };
      app.settings.save({
        baseUrl: provider.url,
        apiProtocol,
        model: "test",
        apiKey: "fixture-only",
        systemPrompt: "",
        expectedRevision: 0,
      });
      const session = app.store.createSession();
      const { run } = app.chat.start(session.id, {
        requestId: "http-preview",
        expectedRevision: 0,
        content: "检查工具输出",
      });
      await expect
        .poll(() => app.store.getRun(run.id).status, { timeout: 5000 })
        .toBe("succeeded");
      expect(provider.requests).toHaveLength(2);
      const feedback =
        provider.requests[1]?.messages.find((m) => m.role === "tool")
          ?.content ?? "";
      expect(feedback.length).toBeLessThanOrEqual(8000);
      expect(feedback).toContain("HTTP_HEAD");
      expect(feedback).toContain("HTTP_TAIL");
      expect(feedback).toContain("read_tool_result");
      expect(JSON.parse(feedback).execution.outcome).toBe("succeeded");
      const result = app.store.execution.list("invocations", {
        runId: run.id,
      })[0]?.result;
      expect(result?.truncated).toBe(true);
      let full = "";
      let cursor: string | undefined;
      do {
        const page = await app.toolSystem.options.results.read(
          result?.resultRef ?? "",
          session.id,
          cursor,
        );
        full += page.text;
        cursor = page.cursor ?? undefined;
      } while (cursor);
      expect(JSON.parse(full).data).toEqual(value);
    } finally {
      await app.server.close();
      await provider.close();
    }
  },
);
