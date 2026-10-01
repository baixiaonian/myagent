/**
 * 缓存结构离线复验：只读指定任务已有的 Chat Completions 调试请求，在内存库中重放上下文准备。
 * 不读取凭证、不联网、不执行模型/工具、不修改用户数据；只输出统计，不导出私有正文。
 * 这是固定执行轨迹的公共前缀对照，不是服务商 KV 命中率或费用收益实测。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  OpenAIChatModel,
  SqliteChatStore,
} from "../packages/adapters/dist/index.js";
import { ContextService } from "../packages/application/dist/index.js";
import { AGENT_LIMITS } from "../packages/contracts/dist/index.js";

const rootRunId = process.argv[2];
assert(rootRunId, "用法：pnpm test:cache:replay <已结束主 Run ID>");
const source = resolve(
  process.env.MYAGENT_SOURCE_DATA_DIR ?? join(homedir(), ".myagent"),
);
const require = createRequire(
  new URL("../packages/adapters/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const db = new Database(join(source, "state.db"), {
  readonly: true,
  fileMustExist: true,
});
const rows = (kind) =>
  db
    .prepare(
      "SELECT data FROM observation_records WHERE kind=? ORDER BY created_at,id",
    )
    .all(kind)
    .map((r) => JSON.parse(r.data));
const calls = rows("calls").filter(
  (call) =>
    call.scope.purpose === "agent" &&
    (call.scope.rootRunId === rootRunId || call.scope.runId === rootRunId),
);
const captures = new Map(
  rows("captures")
    .filter((c) => c.direction === "input" && c.status === "complete")
    .map((c) => [c.callId, c]),
);
db.close();
assert(calls.length, "没有找到该任务的模型调用");
const groups = Map.groupBy(calls, (c) => c.scope.runId);
const report = {
  calls: calls.length,
  replayed: 0,
  pairs: 0,
  originalAppendOnly: 0,
  optimizedAppendOnly: 0,
  originalSystemChanges: 0,
  optimizedSystemChanges: 0,
  optimizedToolsChanges: 0,
  unknownCacheRequests: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  summaryRequests: 0,
  networkRequests: 0,
};
const appendOnly = (before, after) =>
  before.length <= after.length &&
  before.every((m, i) => JSON.stringify(m) === JSON.stringify(after[i]));
const projection = (messages) =>
  messages.map(({ sourceId: _s, resultInfo: _r, ...message }) => message);
// 即使日后重构误用模型端口，离线复验也不能意外产生网络请求或费用。
globalThis.fetch = async () => {
  report.networkRequests++;
  throw Error("离线复验禁止联网");
};
for (const group of groups.values()) {
  const store = new SqliteChatStore(":memory:");
  try {
    const session = store.createSession();
    const run = store.beginRun({
      sessionId: session.id,
      requestId: "replay",
      expectedRevision: 0,
      fingerprint: "replay",
      kind: "send",
      content: "离线结构验证",
      model: "offline",
      contextTrimmed: false,
    });
    let facts = "";
    const service = new ContextService(
      store.context,
      store,
      store.execution,
      { read: () => null },
      () => facts,
    );
    service.initialize(run, {
      ...store.settings(),
      contextWindowTokens: 200000,
      outputReserveTokens: 4096,
    });
    const adapter = new OpenAIChatModel(
      "http://127.0.0.1:1/v1",
      "offline-placeholder",
      "offline",
    );
    const model = {
      estimateInput: adapter.estimateInput.bind(adapter),
      stream() {
        report.summaryRequests++;
        throw Error("本复验不允许额外摘要请求");
      },
    };
    let previous;
    for (const call of group) {
      const capture = captures.get(call.id);
      if (!capture) {
        previous = undefined;
        continue;
      }
      // 材料路径只接受仓储生成的十六进制 ID，不能从请求体或参数读取任意文件。
      assert(/^[a-f0-9]+$/.test(capture.id), "非法材料身份");
      const body = JSON.parse(
        readFileSync(
          join(source, "observability/captures", `${capture.id}.raw`),
          "utf8",
        ),
      );
      if (!Array.isArray(body.messages)) {
        previous = undefined;
        continue;
      }
      const [system, ...rest] = body.messages;
      assert(
        system?.role === "system" && rest[0]?.role === "user",
        "该轨迹的首部布局不支持此离线复验",
      );
      const marker = system.content.indexOf("执行事实索引");
      const instructions = (
        marker < 0 ? system.content : system.content.slice(0, marker)
      ).trimEnd();
      facts = marker < 0 ? "" : system.content.slice(marker);
      const current = rest.map((m, i) => ({
        role: m.role,
        content: m.content ?? "",
        sourceId: i === 0 ? run.userMessageId : `replay:${i}`,
        ...(m.tool_call_id ? { callId: m.tool_call_id } : {}),
        ...(m.tool_calls
          ? {
              toolCalls: m.tool_calls.map((c) => ({
                id: c.id,
                name: c.function.name,
                arguments: c.function.arguments,
              })),
            }
          : {}),
        ...(m.reasoning_content !== undefined
          ? {
              continuation: {
                protocol: "chat_completions",
                reasoningContent: m.reasoning_content,
              },
            }
          : {}),
      }));
      const tools = (body.tools ?? []).map((t) => t.function);
      const result = await service.forRun(run, model).prepare(
        {
          instructions,
          current,
          history: [],
          tools,
          limits: { ...AGENT_LIMITS },
        },
        new AbortController().signal,
      );
      const projected = projection(result.messages);
      if (previous) {
        report.pairs++;
        report.originalAppendOnly += Number(
          appendOnly(previous.original, body.messages),
        );
        report.optimizedAppendOnly += Number(
          appendOnly(previous.optimized, projected),
        );
        report.originalSystemChanges += Number(
          previous.original[0].content !== system.content,
        );
        report.optimizedSystemChanges += Number(
          previous.optimized[0].content !== projected[0].content,
        );
        report.optimizedToolsChanges += Number(
          previous.tools !== JSON.stringify(tools),
        );
      }
      previous = {
        original: body.messages,
        optimized: projected,
        tools: JSON.stringify(tools),
      };
      report.replayed++;
      if (call.usage?.cacheReadTokens === undefined)
        report.unknownCacheRequests++;
      else {
        report.inputTokens += call.usage.inputTokens;
        report.cacheReadTokens += call.usage.cacheReadTokens;
      }
    }
  } finally {
    store.close();
  }
}
assert.equal(report.summaryRequests, 0);
console.info(
  JSON.stringify(
    {
      ...report,
      historicalProviderHitRate: report.inputTokens
        ? report.cacheReadTokens / report.inputTokens
        : null,
      optimizedProviderHitRate: null,
      note: "优化后仅验证请求结构；未请求真实模型，实际命中率待后续使用观察。",
    },
    null,
    2,
  ),
);
