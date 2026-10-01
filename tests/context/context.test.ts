/**
 * 上下文纯策略及持久化故障测试：低容量构造单轮超限，摘要替身不代表真实模型兼容。
 * 验证配对、分块、失败抑制、取消、来源复用和规则边界；原始历史不由摘要覆盖。
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  FileResultStore,
  LocalProjectRules,
  SqliteChatStore,
} from "../../packages/adapters/src/index.js";
import { ContextService } from "../../packages/application/src/index.js";
import { AGENT_LIMITS, AppError } from "../../packages/contracts/dist/index.js";
import {
  type ContextInput,
  contextBudget,
  estimateTokens,
  type ModelMessage,
  type ModelPort,
  messageBlocks,
} from "../../packages/kernel/src/index.js";

const stores: SqliteChatStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
function fixture(ratio = 0.8) {
  const store = new SqliteChatStore(":memory:");
  stores.push(store);
  const session = store.createSession();
  const settings = {
    ...store.settings(),
    contextWindowTokens: 8192,
    outputReserveTokens: 1024,
  };
  const run = store.beginRun({
    sessionId: session.id,
    requestId: "one",
    expectedRevision: 0,
    fingerprint: "one",
    kind: "send",
    content: "继续分析日志并验证",
    model: "fixture",
    contextTrimmed: false,
  });
  const service = new ContextService(
    store.context,
    store,
    store.execution,
    { read: () => null },
    () => "",
    undefined,
    ratio,
  );
  service.initialize(run, settings);
  const requests: ModelMessage[][] = [];
  const model: ModelPort = {
    async *stream(messages, _signal, tools) {
      expect(tools).toEqual([]);
      requests.push(structuredClone(messages) as ModelMessage[]);
      yield {
        type: "text",
        text: "目标：继续分析日志。已发现问题，尚未完成验证；必要时查阅历史原文。",
      };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      };
    },
  };
  const input = (tail: ModelMessage[]): ContextInput => ({
    instructions: "",
    history: [],
    current: [
      {
        role: "user",
        sourceId: run.userMessageId,
        content: "继续分析日志并验证",
      },
      ...tail,
    ],
    tools: [],
    limits: { ...AGENT_LIMITS },
  });
  return { store, session, run, settings, service, model, requests, input };
}
it("按完整工具批次分块，孤立结果、缺失结果和重复 ID 拒绝", () => {
  expect(() =>
    messageBlocks([{ role: "tool", callId: "x", content: "bad" }]),
  ).toThrow("未配对");
  expect(() =>
    messageBlocks([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "x", name: "t", arguments: "{}" }],
      },
    ]),
  ).toThrow("不完整");
  expect(
    messageBlocks([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "x", name: "t", arguments: "{}" }],
      },
      { role: "tool", callId: "x", content: "ok" },
    ]),
  ).toHaveLength(1);
});
it("普通请求不调用摘要，窗口估算扣除输出与安全余量", async () => {
  const f = fixture();
  const result = await f.service
    .forRun(f.run, f.model)
    .prepare?.(f.input([]), new AbortController().signal);
  expect(f.requests).toHaveLength(0);
  expect(result?.messages.at(-1)?.content).toBe("继续分析日志并验证");
  expect(contextBudget(f.settings).input).toBe(5939);
  expect(f.store.context.list("manifests", f.session.id)).toHaveLength(1);
});
it("单轮超大消息分块摘要，私有续接不进入摘要输入，来源与配对保持", async () => {
  const f = fixture();
  const tail: ModelMessage[] = [
    {
      role: "assistant",
      sourceId: "step-a",
      content: "日志分析证据".repeat(5000),
      toolCalls: [{ id: "call-a", name: "logs", arguments: "{}" }],
      continuation: { secretReasoning: "PRIVATE_REASONING" },
    },
    {
      role: "tool",
      sourceId: "result-a",
      callId: "call-a",
      content: "完整结果".repeat(5000),
      resultInfo: { resultRef: "ref-a", outcome: "succeeded" },
    },
  ];
  const before = JSON.stringify(tail);
  const builder = f.service.forRun(f.run, f.model);
  const result = await builder.prepare?.(
    f.input(tail),
    new AbortController().signal,
  );
  expect(f.requests.length).toBeGreaterThan(1);
  expect(JSON.stringify(f.requests)).not.toContain("PRIVATE_REASONING");
  expect(
    f.requests.every((r) => estimateTokens({ messages: r, tools: [] }) <= 5939),
  ).toBe(true);
  expect(JSON.stringify(tail)).toBe(before);
  expect(result?.messages.some((m) => m.content.includes("历史资料摘要"))).toBe(
    true,
  );
  expect(() => messageBlocks(result?.messages ?? [])).not.toThrow();
  expect(f.service.view(f.session.id)?.summaries[0]?.sourceIds).toEqual([
    "step-a",
  ]);
  expect(f.service.view(f.session.id)?.compactionUsage?.totalTokens).toBe(
    f.requests.length * 30,
  );
  const count = f.requests.length;
  await builder.prepare?.(f.input(tail), new AbortController().signal);
  expect(f.requests).toHaveLength(count);
});
it("最新单批巨大工具结果先缩预览，保留调用和结果引用", async () => {
  const f = fixture();
  const result = await f.service.forRun(f.run, f.model).prepare?.(
    f.input([
      {
        role: "assistant",
        sourceId: "step",
        content: "",
        toolCalls: [{ id: "c", name: "logs", arguments: "{}" }],
      },
      {
        role: "tool",
        callId: "c",
        content: "结果".repeat(30000),
        resultInfo: { resultRef: "ref", outcome: "succeeded" },
      },
    ]),
    new AbortController().signal,
  );
  expect(result?.messages.find((m) => m.role === "tool")?.content).toContain(
    "ref",
  );
  expect(result?.messages.find((m) => m.role === "tool")?.content).toContain(
    "截断",
  );
  expect(() => messageBlocks(result?.messages ?? [])).not.toThrow();
});
it("摘要失败在软阈值继续，禁止反复自动调用；硬超限暂停且可手动重试", async () => {
  const f = fixture(0.05);
  let calls = 0;
  const failing: ModelPort = {
    async *stream() {
      calls++;
      yield { type: "text", text: "未完成的草稿" };
      throw new AppError("model_connection", "模拟网络失败");
    },
  };
  const builder = f.service.forRun(f.run, failing);
  await builder.prepare?.(
    f.input([
      { role: "assistant", sourceId: "old", content: "较早分析".repeat(300) },
      { role: "assistant", sourceId: "latest", content: "最新观察，保留原文" },
    ]),
    new AbortController().signal,
  );
  expect(f.service.view(f.session.id)?.status).toBe("warning");
  expect(calls).toBe(1);
  await builder.prepare?.(
    f.input([
      { role: "assistant", sourceId: "old", content: "较早分析".repeat(300) },
      { role: "assistant", sourceId: "latest", content: "最新观察，保留原文" },
    ]),
    new AbortController().signal,
  );
  expect(calls).toBe(1);
  await expect(
    builder.prepare?.(
      f.input([
        {
          role: "assistant",
          sourceId: "large",
          content: "巨大文本".repeat(6000),
        },
      ]),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "execution_paused" });
  expect(f.store.getRun(f.run.id).status).toBe("waiting_context");
  expect(() =>
    f.store.beginRun({
      sessionId: f.session.id,
      requestId: "two",
      expectedRevision: f.store.snapshot(f.session.id).session.revision,
      fingerprint: "two",
      kind: "send",
      content: "并发",
      model: "f",
      contextTrimmed: false,
    }),
  ).toThrow();
  expect(
    f.service.resume(
      f.run.id,
      { contextAction: "retry", requestId: "resume" },
      f.settings,
    ),
  ).toBe(true);
  expect(
    f.service.resume(
      f.run.id,
      { contextAction: "retry", requestId: "resume" },
      f.settings,
    ),
  ).toBe(false);
  f.store.execution.setRunStatus(f.run.id, "running");
  await f.service.forRun(f.run, f.model).prepare?.(
    f.input([
      {
        role: "assistant",
        sourceId: "large",
        content: "巨大文本".repeat(6000),
      },
    ]),
    new AbortController().signal,
  );
  expect(f.service.view(f.session.id)?.status).toBe("ready");
});
it("必要内容超限不调用摘要，只有容量明确更新才采用新值", async () => {
  const f = fixture();
  await expect(
    f.service
      .forRun(f.run, f.model)
      .prepare?.(
        { ...f.input([]), instructions: "必须保留".repeat(3000) },
        new AbortController().signal,
      ),
  ).rejects.toMatchObject({ code: "execution_paused" });
  expect(f.requests).toHaveLength(0);
  expect(f.service.view(f.session.id)?.error?.code).toBe(
    "context_base_too_large",
  );
  f.service.resume(
    f.run.id,
    { requestId: "c", contextAction: "apply_capacity" },
    { ...f.settings, contextWindowTokens: 65536 },
  );
  expect(
    f.store.context.get("runs", f.run.id)?.capacity.contextWindowTokens,
  ).toBe(65536);
});
it("取消不合作的摘要模型及时退出，迟到结果不能发布", async () => {
  const f = fixture(0.05);
  const controller = new AbortController();
  let release: (
    value: IteratorResult<
      import("../../packages/kernel/src/index.js").ModelEvent
    >,
  ) => void = () => {};
  const hanging: ModelPort = {
    stream() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise((resolve) => {
                release = resolve;
              }),
          };
        },
      };
    },
  };
  const pending = f.service.forRun(f.run, hanging).prepare?.(
    f.input([
      { role: "assistant", sourceId: "old", content: "文本".repeat(900) },
      { role: "assistant", sourceId: "latest", content: "最新观察" },
    ]),
    controller.signal,
  );
  await expect
    .poll(() => f.service.view(f.session.id)?.status)
    .toBe("compacting");
  controller.abort(new AppError("cancelled", "已停止"));
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  release({ done: false, value: { type: "text", text: "迟到摘要" } });
  expect(f.store.context.list("summaries", f.session.id)).toHaveLength(0);
  expect(f.store.context.list("jobs", f.session.id)[0]?.status).toBe(
    "interrupted",
  );
});
it("项目规则仅根目录读取，拒绝越界链接及过大文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "myagent-rules-"));
  try {
    const root = join(dir, "project");
    mkdirSync(root);
    const rules = new LocalProjectRules();
    expect(rules.read(root)).toBeNull();
    writeFileSync(join(root, "AGENTS.md"), "用中文回答");
    expect(rules.read(root)?.text).toBe("用中文回答");
    rmSync(join(root, "AGENTS.md"));
    writeFileSync(join(dir, "outside"), "规则");
    symlinkSync(join(dir, "outside"), join(root, "AGENTS.md"));
    expect(() => rules.read(root)).toThrow("外部");
    rmSync(join(root, "AGENTS.md"));
    writeFileSync(join(root, "AGENTS.md"), "x".repeat(65537));
    expect(() => rules.read(root)).toThrow("64 KiB");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("历史分页白名单不含私有续接，游标不能跨会话，删除会话级联清理", () => {
  const f = fixture();
  f.store.saveStep({
    identity: "fixture",
    continuation: { private: "PRIVATE" },
    step: {
      id: "step-one",
      runId: f.run.id,
      index: 1,
      status: "completed",
      content: "正文".repeat(6000),
      tools: [],
      finishReason: "stop",
      usage: null,
      error: null,
      createdAt: new Date().toISOString(),
      endedAt: null,
    },
  });
  const page = f.store.context.history(f.session.id, { sourceId: "step-one" });
  expect(page.entries[0]?.text.length).toBe(8000);
  expect(page.nextCursor).toBeTruthy();
  expect(JSON.stringify(page)).not.toContain("PRIVATE");
  const next = f.store.context.history(f.session.id, {
    sourceId: "step-one",
    cursor: page.nextCursor ?? "",
  });
  expect(next.entries[0]?.offset).toBe(8000);
  const other = f.store.createSession();
  expect(() =>
    f.store.context.history(other.id, {
      sourceId: "step-one",
      cursor: page.nextCursor ?? "",
    }),
  ).toThrow("游标");
  f.store.deleteSession(f.session.id);
  expect(f.store.context.get("runs", f.run.id)).toBeNull();
});

it("软阈值低于固定输入时仍保留最新工具观察，不为同一观察反复摘要", async () => {
  const f = fixture(0.01);
  const current: ModelMessage[] = [
    {
      role: "assistant",
      sourceId: "clock-step",
      content: "",
      toolCalls: [{ id: "clock", name: "get_current_time", arguments: "{}" }],
    },
    { role: "tool", callId: "clock", content: "2026-09-26T09:00:00Z" },
  ];
  const prepared = await f.service
    .forRun(f.run, f.model)
    .prepare?.(f.input(current), new AbortController().signal);
  expect(f.requests).toHaveLength(0);
  expect(prepared?.messages.at(-1)?.role).toBe("tool");
  expect(prepared?.messages.at(-1)?.content).toBe("2026-09-26T09:00:00Z");
});

it("发布事务中失败时不启用候选摘要，也不留下半份请求清单", async () => {
  const f = fixture();
  const original = f.store.context.put.bind(f.store.context);
  f.store.context.put = (kind, record) => {
    original(kind, record);
    if (kind === "runs" && "view" in record && record.view.version > 0)
      throw new Error("publish-fault");
  };
  await expect(
    f.service.forRun(f.run, f.model).prepare?.(
      f.input([
        {
          role: "assistant",
          sourceId: "large",
          content: "来源资料".repeat(6000),
        },
      ]),
      new AbortController().signal,
    ),
  ).rejects.toThrow("publish-fault");
  expect(
    f.store.context.list("summaries", f.session.id).filter((s) => s.published),
  ).toHaveLength(0);
  expect(f.store.context.list("manifests", f.session.id)).toHaveLength(0);
  expect(f.store.context.get("runs", f.run.id)?.summaryIds).toEqual([]);
  f.store.context.put = original;
});

it("旧检查点升级不读取后来出现的根规则，旧步骤获得真实可查来源", async () => {
  const f = fixture();
  const next = f.store.createSession({
    id: crypto.randomUUID(),
    workspace: {
      id: "legacy-workspace",
      name: "legacy",
      path: "/unused-legacy-workspace",
      identity: "legacy",
      createdAt: "old",
    },
  });
  const run = f.store.beginRun({
    sessionId: next.id,
    requestId: "legacy",
    expectedRevision: 0,
    fingerprint: "legacy",
    kind: "send",
    content: "旧任务",
    model: "fixture",
    contextTrimmed: false,
  });
  const service = new ContextService(
    f.store.context,
    f.store,
    f.store.execution,
    {
      read() {
        throw new Error("不得加载新规则");
      },
    },
    () => "",
  );
  service.initialize(run, f.settings, null, true);
  expect(f.store.context.get("runs", run.id)?.rules).toBe("");
  f.store.saveStep({
    identity: "fixture",
    continuation: null,
    step: {
      id: "legacy-real-step",
      runId: run.id,
      index: 1,
      status: "completed",
      content: "旧步骤".repeat(5000),
      tools: [],
      finishReason: "stop",
      usage: null,
      error: null,
      createdAt: new Date().toISOString(),
      endedAt: null,
    },
  });
  await service.forRun(run, f.model).prepare?.(
    {
      ...f.input([{ role: "assistant", content: "旧步骤".repeat(5000) }]),
      current: [
        { role: "user", content: "旧任务" },
        { role: "assistant", content: "旧步骤".repeat(5000) },
      ],
    },
    new AbortController().signal,
  );
  expect(service.view(next.id)?.summaries[0]?.sourceIds).toEqual([
    "legacy-real-step",
  ]);
  expect(
    f.store.context.history(next.id, { sourceId: "legacy-real-step" }).entries,
  ).toHaveLength(1);
});

it("结果采集完整性与模型预览截断相互独立，未知省略量不能填零", async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), "myagent-capture-"));
  try {
    const results = new FileResultStore(dir, f.store.execution);
    const context = {
      sessionId: f.session.id,
      runId: f.run.id,
      stepId: "step",
      invocationId: "call",
      workspace: null,
    };
    for (const complete of [false, true]) {
      const saved = await results.save(
        context,
        { text: "内容".repeat(5000) },
        complete,
      );
      expect(saved.truncated).toBe(true);
      const page = await results.read(saved.reference.id, f.session.id);
      expect(page.captureComplete).toBe(complete);
      expect(page.omittedBytes).toBe(complete ? 0 : null);
      expect(page.captureReason).toBe(
        complete ? "complete" : "capture_incomplete",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("历史分页不切断 emoji，连续页可以还原保存的原文", () => {
  const f = fixture();
  const text = "字".repeat(7999) + "😀尾";
  f.store.appendDelta(f.run.id, text);
  const first = f.store.context.history(f.session.id, {
    sourceId: f.run.assistantMessageId,
  });
  expect(first.entries[0]?.text.length).toBe(7999);
  const next = f.store.context.history(f.session.id, {
    sourceId: f.run.assistantMessageId,
    cursor: first.nextCursor ?? "",
  });
  expect((first.entries[0]?.text ?? "") + (next.entries[0]?.text ?? "")).toBe(
    text,
  );
});

// 历史摘要的总量不再形成配额；每份摘要依旧受输入窗口与摘要目标约束。
it("累计摘要超过旧上限后仍可分块整理，旧剩余额度字段不再阻断", async () => {
  const f = fixture();
  const state = f.store.context.get("runs", f.run.id);
  if (!state) throw new Error("context state missing");
  state.summaryOutputCharacters = 300000;
  f.store.context.put("runs", state);
  const input = Object.assign(
    f.input([
      {
        role: "assistant",
        sourceId: "long-step",
        content: "已完成的排查证据。".repeat(6000),
      },
    ]),
    { remainingOutputCharacters: 1 },
  );
  Object.assign(input.limits, { outputCharacters: 1 });
  const result = await f.service
    .forRun(f.run, f.model)
    .prepare?.(input, new AbortController().signal);
  expect(f.requests.length).toBeGreaterThan(1);
  expect(result?.messages.some((m) => m.content.includes("历史资料摘要"))).toBe(
    true,
  );
  expect(
    f.store.context.get("runs", f.run.id)?.summaryOutputCharacters,
  ).toBeGreaterThan(300000);
  expect(
    f.requests.every((r) => estimateTokens({ messages: r, tools: [] }) <= 5939),
  ).toBe(true);
});

it("完整摘要略超目标仍可使用，终态 usage 不丢失且不增加整理请求", async () => {
  const f = fixture(0.05);
  const budget = contextBudget(f.settings);
  const text = "摘".repeat(budget.summary + 100);
  let requests = 0;
  const model: ModelPort = {
    async *stream() {
      requests++;
      yield { type: "text", text };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { inputTokens: 5000, outputTokens: 1000, totalTokens: 6000 },
      };
    },
  };
  const prepared = await f.service.forRun(f.run, model).prepare?.(
    f.input([
      { role: "assistant", sourceId: "old", content: "信息".repeat(1700) },
      { role: "assistant", sourceId: "new", content: "最近观察" },
    ]),
    new AbortController().signal,
  );
  expect(prepared?.messages.some((m) => m.content.includes(text))).toBe(true);
  expect(requests).toBe(1);
  expect(f.service.view(f.session.id)?.status).toBe("ready");
  expect(
    f.store.context.list("jobs", f.session.id)[0]?.usage?.totalTokens,
  ).toBe(6000);
});

it("真正过大的完整摘要拒绝发布但保留终态用量，不自动重试或截断成半份摘要", async () => {
  const f = fixture(0.05);
  let requests = 0;
  const model: ModelPort = {
    async *stream() {
      requests++;
      yield {
        type: "text",
        text: "长".repeat(contextBudget(f.settings).summaryMax + 1),
      };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { inputTokens: 4000, outputTokens: 2000, totalTokens: 6000 },
      };
    },
  };
  const input = f.input([
    { role: "assistant", sourceId: "old", content: "资料".repeat(1700) },
    { role: "assistant", sourceId: "latest", content: "最新结果" },
  ]);
  await f.service
    .forRun(f.run, model)
    .prepare?.(input, new AbortController().signal);
  await f.service
    .forRun(f.run, model)
    .prepare?.(input, new AbortController().signal);
  expect(requests).toBe(1);
  expect(f.store.context.list("summaries", f.session.id)).toHaveLength(0);
  expect(
    f.store.context.list("jobs", f.session.id)[0]?.usage?.totalTokens,
  ).toBe(6000);
  expect(f.service.view(f.session.id)?.error?.code).toBe(
    "context_summary_size",
  );
});
