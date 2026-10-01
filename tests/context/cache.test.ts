/**
 * 缓存前缀回归：真实上下文仓储与双协议 HTTP 验证执行状态只追加、重启不改旧前缀。
 * 检查的是发送内容的结构，不把离线公共前缀比例冒充服务商实际缓存命中率。
 */
import { afterEach, expect, it } from "vitest";
import {
  OpenAIChatModel,
  OpenAIResponsesModel,
  SqliteChatStore,
} from "../../packages/adapters/src/index.js";
import { ContextService } from "../../packages/application/src/index.js";
import {
  AGENT_LIMITS,
  type ToolDefinition,
} from "../../packages/contracts/dist/index.js";
import type {
  ContextInput,
  ModelMessage,
  ModelPort,
} from "../../packages/kernel/src/index.js";
import { mockProvider } from "../chat/provider.js";

const stores: SqliteChatStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture(window = 200000) {
  const store = new SqliteChatStore(":memory:");
  stores.push(store);
  const session = store.createSession();
  const settings = {
    ...store.settings(),
    contextWindowTokens: window,
    outputReserveTokens: 1024,
  };
  const run = store.beginRun({
    sessionId: session.id,
    requestId: "cache",
    expectedRevision: 0,
    fingerprint: "cache",
    kind: "send",
    content: "分析项目",
    model: "fixture",
    contextTrimmed: false,
  });
  let facts = "";
  const create = () =>
    new ContextService(
      store.context,
      store,
      store.execution,
      { read: () => null },
      () => facts,
    );
  const service = create();
  service.initialize(run, settings);
  const current: ModelMessage[] = [
    { role: "user", sourceId: run.userMessageId, content: "分析项目" },
  ];
  const input: ContextInput = {
    instructions: "固定项目规则",
    current,
    history: [],
    tools: [],
    limits: { ...AGENT_LIMITS },
  };
  const model: ModelPort = {
    async *stream() {
      yield { type: "text", text: "已完成检查，原记录可查。" };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
  return {
    store,
    session,
    run,
    create,
    service,
    current,
    input,
    model,
    setFacts: (value: string) => {
      facts = value;
    },
  };
}
function batch(index: number, text = "文件内容"): ModelMessage[] {
  return [
    {
      role: "assistant",
      sourceId: `step:${index}`,
      content: "检查文件",
      toolCalls: [
        {
          id: `call:${index}`,
          name: "read_file",
          arguments: '{"path":"README.md"}',
        },
      ],
    },
    {
      role: "tool",
      sourceId: `result:${index}`,
      callId: `call:${index}`,
      content: text,
    },
  ];
}
it.each(["responses", "chat_completions"] as const)(
  "%s 执行状态变化后真实请求仍以完整旧输入开头",
  async (protocol) => {
    const f = fixture();
    const provider = await mockProvider();
    try {
      const model =
        protocol === "responses"
          ? new OpenAIResponsesModel(provider.url, "fake", "test")
          : new OpenAIChatModel(provider.url, "fake", "test");
      const send = async (service = f.service) => {
        const prepared = await service
          .forRun(f.run, model)
          .prepare?.(f.input, new AbortController().signal);
        if (!prepared) throw Error("missing context");
        for await (const _ of model.stream(
          prepared.messages,
          new AbortController().signal,
          [],
        )) {
          /* 真实 HTTP 序列化，不调用外部模型。 */
        }
        const body = provider.requests.at(-1);
        return protocol === "responses" ? body?.input : body?.messages;
      };
      f.setFacts('执行事实索引：{"activeProcesses":1}');
      const first = await send();
      f.current.push(...batch(1));
      f.setFacts('执行事实索引：{"activeProcesses":0,"effects":1}');
      const second = await send();
      expect(second?.slice(0, first?.length)).toEqual(first);
      const refs = f.store.context.get("runs", f.run.id)?.executionNotes;
      expect(refs).toHaveLength(2);
      const noteId = refs?.at(-1)?.id;
      if (!noteId) throw Error("状态来源未保存");
      const safe = f.store.context.history(f.session.id, { sourceId: noteId });
      expect(safe.entries[0]?.kind).toBe("context");
      expect(safe.entries[0]?.text).toContain("执行状态更新");
      const other = f.store.createSession();
      expect(
        f.store.context.history(other.id, { sourceId: noteId }).entries,
      ).toEqual([]);
      // 重新创建服务，使用仓储中的锚点和原文；同一准备请求不追加重复记录。
      expect(await send(f.create())).toEqual(second);
      expect(f.store.context.get("runs", f.run.id)?.executionNotes).toEqual(
        refs,
      );
      f.current.push(...batch(2));
      f.setFacts("");
      const cleared = await send();
      expect(cleared?.slice(0, second?.length)).toEqual(second);
      expect(JSON.stringify(cleared?.at(-1))).toContain("当前没有已记录");
      expect(JSON.stringify(cleared?.[0])).not.toContain("执行事实索引");
    } finally {
      await provider.close();
    }
  },
);
it("压缩后最新执行状态保留原文，下一次准备复用摘要与追加锚点", async () => {
  const f = fixture(8192);
  const prepare = () =>
    f.service
      .forRun(f.run, f.model)
      .prepare?.(f.input, new AbortController().signal);
  f.setFacts("进程 p1 运行中，结果未知");
  await prepare();
  f.current.push(...batch(1, "工具正文".repeat(1000)));
  f.setFacts("进程 p1 已退出，待核对写入结果");
  await prepare();
  f.current.push({
    role: "assistant",
    sourceId: "big",
    content: "已完成排查".repeat(5000),
  });
  const result = await prepare();
  expect(result?.messages.some((m) => m.content.includes("历史资料摘要"))).toBe(
    true,
  );
  expect(
    result?.messages.some((m) =>
      m.content.includes("进程 p1 已退出，待核对写入结果"),
    ),
  ).toBe(true);
  const repeat = await prepare();
  expect(repeat?.messages).toEqual(result?.messages);
});
it("缩小后的工具预览不在下一次请求恢复到 8000 字符", async () => {
  const f = fixture();
  f.current.push(...batch(1, "A".repeat(10000)));
  const state = f.store.context.get("runs", f.run.id);
  if (!state) throw Error("state");
  // 模拟上一请求因窗口不足缩至 512；完整历史仍为一万字符。
  state.previewLimits = { "result:1": 512 };
  f.store.context.put("runs", state);
  const result = await f.service
    .forRun(f.run, f.model)
    .prepare?.(f.input, new AbortController().signal);
  expect(
    result?.messages.find((m) => m.role === "tool")?.content.length,
  ).toBeLessThanOrEqual(512);
  expect(f.current.at(-1)?.content.length).toBe(10000);
});

it("执行状态按身份生成小增量，压缩基线后重新追加完整快照", async () => {
  const f = fixture(16384);
  const invocations = Array.from({ length: 20 }, (_, i) => ({
    sourceId: `invocation-${i}`,
    tool: "exec_command",
    status: "succeeded",
    resultRef: `reference-${i}`,
  }));
  const facts = (effects: number, rows: typeof invocations) =>
    `执行事实索引（不代表授权）：\n${JSON.stringify({ effects, unresolved: 0, activeProcesses: 0, invocations: rows, processes: [], more: true })}`;
  const prepare = () =>
    f.service
      .forRun(f.run, f.model)
      .prepare?.(f.input, new AbortController().signal);
  f.setFacts(facts(20, invocations));
  const first = await prepare();
  f.current.push(...batch(1));
  const next = [
    {
      sourceId: "new-invocation",
      tool: "exec_command",
      status: "succeeded",
      resultRef: "new-ref",
    },
    ...invocations.slice(0, 19),
  ];
  f.setFacts(facts(21, next));
  const second = await prepare();
  expect(second?.messages.slice(0, first?.messages.length)).toEqual(
    first?.messages,
  );
  const delta = second?.messages.at(-1)?.content ?? "";
  expect(delta).toContain("执行事实索引增量");
  expect(delta).toContain('"removedFromIndex":["invocation-19"]');
  expect(delta.length).toBeLessThan(facts(21, next).length / 2);
  f.current.push({
    role: "assistant",
    sourceId: "force-compact",
    content: "排查过程".repeat(10000),
  });
  const compacted = await prepare();
  expect(
    compacted?.messages.some((m) => m.content.includes(facts(21, next))),
  ).toBe(true);
  expect((await prepare())?.messages).toEqual(compacted?.messages);
});
it("取消后不发布状态快照，缺失快照不静默重建", async () => {
  const f = fixture();
  f.setFacts("状态1");
  const c = new AbortController();
  c.abort();
  await expect(
    f.service.forRun(f.run, f.model).prepare?.(f.input, c.signal),
  ).rejects.toBeDefined();
  expect(f.store.context.get("runs", f.run.id)?.executionNotes).toBeUndefined();
  const state = f.store.context.get("runs", f.run.id);
  if (!state) throw Error("state");
  state.executionNotes = [
    { id: "missing", afterSourceId: f.run.userMessageId },
  ];
  f.store.context.put("runs", state);
  await expect(
    f.service
      .forRun(f.run, f.model)
      .prepare?.(f.input, new AbortController().signal),
  ).rejects.toMatchObject({ code: "context_missing" });
});

it("状态更新不能使软阈值压缩提前覆盖最新业务批次", async () => {
  const f = fixture(8192);
  f.current.push({
    role: "assistant",
    sourceId: "old",
    content: "旧过程".repeat(1900),
  });
  f.current.push(...batch(1, "最新验证结果：全部通过"));
  f.setFacts("最新执行计数 1");
  const prepared = await f.service
    .forRun(f.run, f.model)
    .prepare?.(f.input, new AbortController().signal);
  expect(
    prepared?.messages.some((m) => m.content.includes("历史资料摘要")),
  ).toBe(true);
  expect(prepared?.messages.find((m) => m.role === "tool")?.content).toContain(
    "最新验证结果：全部通过",
  );
});

it.each(["responses", "chat_completions"] as const)(
  "%s 工具来源顺序和 Schema 键顺序不影响实际请求",
  async (protocol) => {
    const provider = await mockProvider();
    try {
      const model =
        protocol === "responses"
          ? new OpenAIResponsesModel(provider.url, "fake", "test")
          : new OpenAIChatModel(provider.url, "fake", "test");
      const a: ToolDefinition = {
        name: "alpha",
        description: "测试",
        parameters: {
          type: "object",
          properties: { y: { type: "string" }, x: { type: "number" } },
          required: ["y", "x"],
        },
      };
      const b: ToolDefinition = {
        name: "beta",
        description: "测试",
        parameters: { type: "object", properties: {} },
      };
      const send = async (tools: ToolDefinition[]) => {
        for await (const _ of model.stream(
          [{ role: "user", content: "你好" }],
          new AbortController().signal,
          tools,
        )) {
          /* 只发往本地协议替身。 */
        }
        return JSON.stringify(provider.requests.at(-1)?.tools);
      };
      const first = await send([b, a]);
      const reordered = {
        ...a,
        parameters: {
          required: ["y", "x"],
          properties: { x: { type: "number" }, y: { type: "string" } },
          type: "object",
        },
      };
      expect(await send([reordered, b])).toBe(first);
      expect(a.parameters.required).toEqual(["y", "x"]);
      expect(Object.keys(a.parameters)).toEqual([
        "type",
        "properties",
        "required",
      ]);
    } finally {
      await provider.close();
    }
  },
);
