/** 观测专项：采集完整性、计价、删除匿名化、重启及故障隔离；所有材料均为临时测试数据。 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  LocalCaptureFiles,
  SqliteChatStore,
} from "../../packages/adapters/src/index.js";
import {
  capturedFetch,
  reportedUsage,
} from "../../packages/adapters/src/observability/transport.js";
import { ObservabilityService } from "../../packages/application/src/observability.js";
import type {
  CaptureRecord,
  ModelPrice,
  ObservationScope,
  Usage,
} from "../../packages/contracts/src/index.js";
import type { ModelPort } from "../../packages/kernel/src/index.js";
import {
  BUILTIN_PRICES,
  emptyUsage,
  mergeUsage,
  priceUsage,
} from "../../packages/observability/src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture(
  fileLimit = 1024 * 1024,
  totalLimit = 1024 ** 3,
  queueLimit = fileLimit,
) {
  const dir = mkdtempSync(join(tmpdir(), "myagent-observation-"));
  const store = new SqliteChatStore(join(dir, "test.db")),
    files = new LocalCaptureFiles(dir, fileLimit, totalLimit, queueLimit);
  const service = new ObservabilityService(store.observations, files);
  cleanups.push(async () => {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, files, service };
}
const price: ModelPrice = {
  id: "test-price",
  revision: 1,
  connection: "http://127.0.0.1/v1",
  model: "test",
  currency: "USD",
  input: "2",
  cacheRead: "0.2",
  cacheWrite: "2.5",
  output: "10",
  source: "测试人工价格",
  verifiedAt: "2026-09-29",
  builtin: false,
};
const usage: Usage = {
  inputTokens: 1000,
  outputTokens: 100,
  totalTokens: 1100,
  cacheReadTokens: 200,
  cacheWriteTokens: 100,
  reasoningTokens: 50,
};
async function consume(
  model: ModelPort,
  scope: ObservationScope = { purpose: "connection_test" },
  signal = new AbortController().signal,
) {
  for await (const _ of model.stream([], signal, [], scope)) {
    /* 消费生成器才能真正开始模型请求。 */
  }
}
function fake(
  service: ObservabilityService,
  body?: (id: string) => Promise<void>,
): ModelPort {
  return {
    async *stream(_m, _signal, _tools, scope) {
      service.sent(scope!.callId!);
      if (body) await body(scope!.callId!);
      yield { type: "done", finishReason: "stop", usage };
    },
  };
}
function record(): CaptureRecord {
  return {
    id: randomBytes(16).toString("hex"),
    callId: "call",
    traceId: "trace",
    direction: "output",
    status: "capturing",
    bytes: 0,
    sha256: null,
    reason: null,
    contentType: "text/event-stream",
    createdAt: new Date().toISOString(),
  };
}

it("缓存命中按实际输入加权，未知缓存与旧匿名汇总不补零", async () => {
  const { service, store } = fixture();
  for (const actual of [
    {
      inputTokens: 1000,
      outputTokens: 10,
      totalTokens: 1010,
      cacheReadTokens: 100,
    },
    {
      inputTokens: 10000,
      outputTokens: 10,
      totalTokens: 10010,
      cacheReadTokens: 9000,
    },
    { inputTokens: 200, outputTokens: 10, totalTokens: 210 },
    {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 200,
    },
  ]) {
    await consume(
      service.wrapModel(
        {
          async *stream(_m, _signal, _tools, scope) {
            service.sent(scope!.callId!);
            yield { type: "done", finishReason: "stop", usage: actual };
          },
        },
        store.settings(),
      ),
    );
  }
  expect(service.usage().total.cache).toEqual({
    readTokens: 9100,
    inputTokens: 11000,
    unknownRequests: 2,
  });
  const total = emptyUsage();
  mergeUsage(total, service.usage().total);
  const legacy = { ...emptyUsage(), requests: 3, inputTokens: 9000 };
  delete legacy.cache;
  mergeUsage(total, legacy);
  expect(total.cache).toEqual({
    readTokens: 9100,
    inputTokens: 11000,
    unknownRequests: 5,
  });
  expect(total.requests).toBe(7);
});

it("uses non-overlapping token categories and fixed decimal prices", () => {
  expect(priceUsage(usage, price)).toEqual({
    cost: "0.002690000",
    reason: null,
  });
  expect(priceUsage({ ...usage, reasoningTokens: 100 }, price)).toEqual(
    priceUsage(usage, price),
  );
  expect(
    priceUsage(
      { ...usage, cacheReadTokens: undefined } as unknown as Usage,
      price,
    ).reason,
  ).toBe("cache_read_usage_missing");
  expect(priceUsage(null, price).reason).toBe("usage_missing");
  expect(priceUsage(usage, null).reason).toBe("price_missing");
  expect(priceUsage({ ...usage, cacheWriteTokens: 900 }, price).reason).toBe(
    "usage_invalid",
  );
  const official = BUILTIN_PRICES.find((p) => p.model === "gpt-5.3-codex")!;
  expect(
    priceUsage(usage, official, {
      startedAt: "2026-09-29T01:00:00Z",
      endedAt: "2026-09-29T01:01:00Z",
      serviceTier: "fast",
    }).reason,
  ).toBe("service_tier_unverified");
  expect(
    priceUsage(usage, official, {
      startedAt: "2026-09-29T01:00:00Z",
      endedAt: "2026-09-29T01:01:00Z",
      serviceTier: "default",
    }).cost,
  ).not.toBeNull();
  const deepseek = BUILTIN_PRICES.find((p) => p.model === "deepseek-flash")!;
  expect(
    priceUsage(usage, deepseek, {
      startedAt: "2026-09-26T02:00:00Z",
      endedAt: "2026-09-26T02:01:00Z",
      serviceTier: null,
    }).cost,
  ).not.toBeNull();
  expect(
    priceUsage(usage, deepseek, {
      startedAt: "2026-09-29T02:00:00Z",
      endedAt: "2026-09-29T02:01:00Z",
      serviceTier: null,
    }).reason,
  ).toBe("peak_calendar_unverified");
});

it("retains exact bounded prefixes and distinguishes file/queue/storage failure", async () => {
  const { files, dir } = fixture(10, 100, 6);
  let captured = record();
  const sink = files.begin(captured, (r) => {
    captured = r;
  });
  sink.write(Buffer.from("abcdefghijkl"));
  await sink.finish();
  expect(captured).toMatchObject({
    status: "partial",
    reason: "queue_limit",
    bytes: 6,
  });
  expect(Buffer.from(await files.read(captured.id, 0, 100)).toString()).toBe(
    "abcdef",
  );
  const second = new LocalCaptureFiles(dir, 4, 100, 10);
  let capped = record();
  const cap = second.begin(capped, (r) => {
    capped = r;
  });
  cap.write(Buffer.from("0123456"));
  await cap.finish();
  expect(capped).toMatchObject({ reason: "file_limit", bytes: 4 });
  await second.close();
  const broken = record();
  mkdirSync(join(dir, "observability/captures", `${broken.id}.part`));
  let fault = broken;
  const failed = files.begin(broken, (r) => {
    fault = r;
  });
  failed.write(Buffer.from("abc"));
  await failed.finish();
  expect(fault.status).toBe("partial");
  expect(fault.reason).toBe("storage_error");
});

it("shutdown finishes dangling capture instead of waiting for a non-cooperative producer", async () => {
  const { files } = fixture();
  let value = record();
  const sink = files.begin(value, (r) => {
    value = r;
  });
  sink.write(Buffer.from("saved prefix"));
  await files.close();
  expect(value).toMatchObject({
    status: "partial",
    reason: "shutdown",
    bytes: 12,
  });
  sink.write(Buffer.from("late"));
  expect(value.bytes).toBe(12);
});

it("captures ordinary/error HTTP bodies and marks interrupted streams without leaking headers", async () => {
  const { service, store } = fixture();
  service.configure({
    requestId: randomUUID(),
    expectedRevision: 0,
    debug: true,
    retentionDays: 30,
  });
  const raw = Buffer.from('{ "error": "原始错误正文" }');
  const model = service.wrapModel(
    fake(service, async (id) => {
      const response = await capturedFetch(
        service,
        id,
        async () =>
          new Response(raw, {
            status: 429,
            headers: {
              "content-type": "application/json",
              "set-cookie": "SECRET",
            },
          }),
      )("http://fixture.invalid", {
        body: '{"system":"保留原样"}',
        headers: { Authorization: "SECRET" },
      });
      expect(Buffer.from(await response.arrayBuffer())).toEqual(raw);
    }),
    { ...store.settings(), baseUrl: price.connection, model: "test" },
  );
  await consume(model);
  await expect
    .poll(() =>
      service.store.list("captures").every((c) => c.status !== "capturing"),
    )
    .toBe(true);
  const call = service.calls()[0]!,
    capture = service
      .call(call.id)
      .captures.find((c) => c.direction === "output")!;
  expect(Buffer.from(await service.raw(call.id, capture.id))).toEqual(raw);
  expect(JSON.stringify(service.call(call.id))).not.toContain("SECRET");
  const interrupted = service.wrapModel(
    fake(service, async (id) => {
      let pull = 0;
      const response = await capturedFetch(
        service,
        id,
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(c) {
                if (pull++ === 0) c.enqueue(Buffer.from("prefix"));
                else c.error(new Error("network broke"));
              },
            }),
          ),
      )("http://fixture.invalid", { body: "{}" });
      await expect(response.text()).rejects.toThrow();
    }),
    { ...store.settings(), baseUrl: price.connection, model: "test" },
  );
  await consume(interrupted);
  await expect
    .poll(
      () =>
        service.store
          .list("captures")
          .filter((c) => c.reason === "stream_error").length,
    )
    .toBe(1);
});

it("records cumulative usage once, preserves price snapshots and anonymizes once", async () => {
  const { service, store } = fixture();
  service.savePrice({ requestId: randomUUID(), expectedRevision: 0, price });
  const scope = {
    runId: "run-a",
    sessionId: "session-a",
    purpose: "agent" as const,
  };
  service.beginRun(scope);
  const model = service.wrapModel(
    fake(service, async (id) => {
      service.metadata(id, { usage });
      service.metadata(id, { usage });
      service.metadata(id, { usage: null });
    }),
    { ...store.settings(), baseUrl: price.connection, model: "test" },
  );
  await consume(model, scope);
  service.endRun("run-a", "succeeded");
  service.savePrice({
    requestId: randomUUID(),
    expectedRevision: 1,
    price: { ...price, currency: "CNY", input: "3" },
  });
  expect(service.calls()[0]?.cost).toBe("0.002690000");
  expect(service.calls()[0]?.currency).toBe("USD");
  expect(service.usage().total.requests).toBe(1);
  expect(service.usage().total.inputTokens).toBe(1000);
  const before = service.usage().total;
  service.anonymizeSession("session-a");
  service.anonymizeSession("session-a");
  expect(service.usage().total).toEqual(before);
  expect(service.usage({ sessionId: "session-a" }).total.requests).toBe(0);
  expect(JSON.stringify(service.store.list("anonymous"))).not.toMatch(
    /session-a|run-a|traceId|callId/,
  );
  service.event(scope, "late", {});
  expect(service.traces().items).toHaveLength(0);
});

it("ledger failure prevents new paid requests but capture failure does not", async () => {
  const { service, store } = fixture();
  let count = 0;
  const model = service.wrapModel(
    fake(service, async () => {
      count++;
    }),
    store.settings(),
  );
  const spy = vi.spyOn(service.store, "put").mockImplementationOnce(() => {
    throw new Error("diagnostic write failure");
  });
  await consume(model);
  expect(count).toBe(1);
  spy.mockRestore();
  const original = service.store.put.bind(service.store);
  const fail = vi
    .spyOn(service.store, "put")
    .mockImplementation((kind, value) => {
      if (kind === "calls") throw new Error("disk full");
      original(kind, value as never);
    });
  await expect(consume(model)).rejects.toMatchObject({ code: "storage_error" });
  fail.mockRestore();
  await expect(consume(model)).rejects.toMatchObject({ code: "storage_error" });
  expect(count).toBe(1);
});

it("restart reconciles partial bytes, paginates UTF-8 and links resumed execution", async () => {
  const { service, store, dir } = fixture();
  service.beginRun({ runId: "resume", sessionId: "s" });
  service.configure({
    requestId: randomUUID(),
    expectedRevision: 0,
    debug: true,
    retentionDays: 30,
  });
  await consume(service.wrapModel(fake(service), store.settings()), {
    runId: "resume",
    sessionId: "s",
  });
  const call = service.calls()[0]!,
    raw = record();
  Object.assign(raw, { callId: call.id, traceId: call.traceId });
  service.store.put("captures", raw);
  writeFileSync(
    join(dir, "observability/captures", `${raw.id}.part`),
    "头尾中文🙂数据",
    { mode: 0o600 },
  );
  const recovered = new ObservabilityService(
    store.observations,
    new LocalCaptureFiles(dir),
  );
  await recovered.initialize();
  expect(recovered.call(call.id).captures[0]).toMatchObject({
    status: "partial",
    reason: "interrupted",
    bytes: 22,
  });
  let offset = 0,
    text = "";
  do {
    const page = await recovered.capturePage(call.id, raw.id, offset, 5);
    text += page.text;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (offset < 100);
  expect(text).toBe("头尾中文🙂数据");
  recovered.beginRun({ runId: "resume", sessionId: "s" });
  const traces = recovered.traces().items;
  expect(traces).toHaveLength(2);
  expect(traces[0]?.previousTraceId).toBe(traces[1]?.id);
  recovered.endRun("resume", "succeeded");
  await recovered.close();
});

it("keeps actual metadata when usage malformed or absent", () => {
  expect(
    reportedUsage(
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      "chat_completions",
    ),
  ).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  expect(
    reportedUsage(
      {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 12 },
      },
      "responses",
    ),
  ).toBeNull();
  expect(
    reportedUsage(
      { input_tokens: NaN, output_tokens: 5, total_tokens: 15 },
      "responses",
    ),
  ).toBeNull();
});

it("prices whole long-context calls with explicit tier and separates currencies", async () => {
  const p = BUILTIN_PRICES.find((p) => p.model === "gpt-6-sol")!;
  const u = {
    inputTokens: 300000,
    outputTokens: 1000,
    totalTokens: 301000,
    cacheReadTokens: 100000,
    cacheWriteTokens: 0,
  };
  const facts = {
    startedAt: "2026-09-29T12:00:00Z",
    endedAt: "2026-09-29T12:00:01Z",
    serviceTier: "default",
  };
  expect(priceUsage(u, p, facts).cost).toBe("0.855000000");
  expect(priceUsage(u, p, { ...facts, serviceTier: "flex" }).cost).toBe(
    "0.427500000",
  );
  expect(priceUsage(u, p, { ...facts, serviceTier: "priority" }).cost).toBe(
    "1.710000000",
  );
  const { service, store } = fixture();
  service.savePrice({ requestId: randomUUID(), expectedRevision: 0, price });
  await consume(
    service.wrapModel(fake(service), {
      ...store.settings(),
      baseUrl: price.connection,
      model: "test",
    }),
  );
  service.savePrice({
    requestId: randomUUID(),
    expectedRevision: 1,
    price: { ...price, currency: "CNY" },
  });
  await consume(
    service.wrapModel(fake(service), {
      ...store.settings(),
      baseUrl: price.connection,
      model: "test",
    }),
  );
  expect(service.usage().total.costs).toEqual({
    USD: "0.002690000",
    CNY: "0.002690000",
  });
});

it("keeps received usage after cancellation and excludes a request cancelled before send", async () => {
  const { service, store } = fixture();
  const controller = new AbortController();
  const model = service.wrapModel(
    {
      async *stream(_m, _s, _t, scope) {
        service.sent(scope!.callId!);
        service.metadata(scope!.callId!, { usage });
        controller.abort(new Error("cancelled"));
        yield { type: "text", text: "partial" };
      },
    },
    store.settings(),
  );
  await expect(
    consume(model, { purpose: "connection_test" }, controller.signal),
  ).rejects.toThrow();
  expect(service.calls()[0]).toMatchObject({ status: "cancelled", usage });
  await expect(
    consume(model, { purpose: "connection_test" }, controller.signal),
  ).rejects.toThrow();
  expect(service.usage().total).toMatchObject({
    requests: 1,
    inputTokens: 1000,
    unknownUsage: 0,
  });
});

it("retains usage while deleting expired traces and protects recoverable work", async () => {
  const { service, store } = fixture();
  service.isRecoverable = (id) => id === "recoverable";
  for (const runId of ["finished", "recoverable"]) {
    service.beginRun({ runId, sessionId: "session" });
    await consume(service.wrapModel(fake(service), store.settings()), {
      runId,
      sessionId: "session",
    });
    service.endRun(runId, "succeeded");
    const trace = service.traces({ runId }).items[0]!;
    trace.endedAt = "2020-01-01T00:00:00Z";
    service.store.put("traces", trace);
  }
  await service.maintain();
  expect(service.traces().items.map((t) => t.scope.runId)).toEqual([
    "recoverable",
  ]);
  expect(service.usage().total.requests).toBe(2);
  expect(service.calls()).toHaveLength(2);
});

it("reclaims the oldest completed capture without deleting its call or an active run", async () => {
  const { service, store, files } = fixture(10, 20);
  service.configure({
    requestId: randomUUID(),
    expectedRevision: 0,
    debug: true,
    retentionDays: 30,
  });
  await consume(service.wrapModel(fake(service), store.settings()));
  const call = service.calls()[0]!;
  let old = { ...record(), callId: call.id, traceId: call.traceId };
  const sink = files.begin(old, (r) => {
    old = r;
    service.store.put("captures", r);
  });
  sink.write(Buffer.from("1234567890"));
  await sink.finish();
  await service.reclaimCaptureSpace();
  expect(service.call(call.id).captures[0]).toMatchObject({
    status: "purged",
    reason: "storage_budget",
  });
  await expect(service.raw(call.id, old.id)).rejects.toMatchObject({
    code: "not_found",
  });
  expect(service.usage().total.requests).toBe(1);
});

it("upgrades an actual v11 database without inventing traces or changing existing sessions", () => {
  const require = createRequire(
    new URL("../../packages/adapters/package.json", import.meta.url),
  );
  const Database = require("better-sqlite3");
  const dir = mkdtempSync(join(tmpdir(), "myagent-observation-upgrade-")),
    path = join(dir, "state.db");
  const raw = new Database(path);
  for (const file of readdirSync("migrations")
    .filter((f) => /^\d+.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 11)
    .sort())
    raw.exec(readFileSync(join("migrations", file), "utf8"));
  raw
    .prepare(
      "INSERT INTO sessions(id,title,created_at,updated_at) VALUES (?,?,?,?)",
    )
    .run("old", "旧会话", "2026-09-28", "2026-09-28");
  raw.pragma("user_version = 11");
  raw.close();
  const store = new SqliteChatStore(path);
  try {
    expect(store.snapshot("old").session.title).toBe("旧会话");
    expect(store.observations.list("calls")).toEqual([]);
    expect(store.observations.list("traces")).toEqual([]);
    expect(store.observations.settings().debug).toBe(false);
  } finally {
    store.close();
  }
  const upgraded = new Database(path);
  expect(upgraded.pragma("user_version", { simple: true })).toBe(13);
  upgraded.pragma("user_version = 14");
  upgraded.close();
  expect(() => new SqliteChatStore(path)).toThrow(/数据库版本较新/);
  rmSync(dir, { recursive: true, force: true });
});

it("marks an altered completed capture as incomplete during startup reconciliation", async () => {
  const { service, store, files, dir } = fixture();
  await consume(service.wrapModel(fake(service), store.settings()));
  const call = service.calls()[0]!;
  let captured = { ...record(), callId: call.id, traceId: call.traceId };
  const writer = files.begin(captured, (r) => {
    captured = r;
    service.store.put("captures", r);
  });
  writer.write(Buffer.from("original"));
  await writer.finish();
  writeFileSync(
    join(dir, "observability/captures", `${captured.id}.raw`),
    "altered",
  );
  await service.initialize();
  expect(service.call(call.id).captures[0]).toMatchObject({
    status: "partial",
    reason: "integrity_mismatch",
    bytes: 7,
  });
});

it("keeps repeated approvals and member work under one live task trace", () => {
  const { service } = fixture();
  const scope = { runId: "main", rootRunId: "main", sessionId: "s" };
  service.beginRun(scope);
  for (let i = 0; i < 3; i++) {
    service.endRun("main", "waiting_approval");
    const member = { runId: `member-${i}`, rootRunId: "main", sessionId: "s" };
    service.beginRun(member);
    service.span(member, "tool.execute").end();
    service.endRun(member.runId, "succeeded");
    service.interval(
      scope,
      "approval.wait",
      new Date().toISOString(),
      new Date().toISOString(),
      "approved",
    );
    service.beginRun(scope);
  }
  service.endRun("main", "succeeded");
  expect(service.traces().items).toHaveLength(1);
  expect(service.traces().items[0]?.status).toBe("succeeded");
  expect(
    service.store
      .list("spans")
      .filter((s) => s.name === "run.waiting_approval"),
  ).toHaveLength(3);
  expect(service.store.list("spans").filter((s) => s.endedAt === null)).toEqual(
    [],
  );
});

it("cancels a paused task without leaving a running trace or allowing late resurrection", () => {
  const { service } = fixture();
  let status: "running" | "cancelled" = "running";
  service.runState = () => ({
    status,
    endedAt: status === "cancelled" ? new Date().toISOString() : null,
    error: null,
  });
  const scope = { runId: "run", sessionId: "s" };
  service.beginRun(scope);
  service.endRun("run", "waiting_approval");
  status = "cancelled";
  service.endRun("run", status);
  service.interval(
    scope,
    "approval.wait",
    new Date().toISOString(),
    new Date().toISOString(),
    "cancelled",
  );
  service.event(scope, "late", {});
  expect(service.traces().items).toHaveLength(1);
  expect(service.traces().items[0]).toMatchObject({
    status: "cancelled",
    task: { status: "cancelled" },
  });
  expect(service.store.list("spans").every((s) => s.endedAt !== null)).toBe(
    true,
  );
});

it.each([false, true])(
  "reconciles stale task metadata after prior shutdown=%s without inventing executions",
  async (shutdown) => {
    const { service, store, files } = fixture();
    service.beginRun({ runId: "old", sessionId: "s" });
    const oldId = service.traces().items[0]!.id;
    const endedAt = new Date().toISOString();
    if (shutdown) await service.close();
    const recovered = new ObservabilityService(store.observations, files);
    recovered.runState = () => ({
      status: "cancelled",
      endedAt,
      error: { code: "cancelled", message: "运行已停止。" },
    });
    await recovered.initialize();
    expect(recovered.traces().items).toHaveLength(1);
    expect(recovered.traces().items[0]).toMatchObject({
      id: oldId,
      status: "cancelled",
      incomplete: true,
    });
    expect(recovered.calls()).toEqual([]);
  },
);

it("Step 从上下文准备开始，事件绑定显式父节点；结束不重复创建 Step", () => {
  const { service, store } = fixture();
  service.beginRun({ runId: "r", sessionId: "s" });
  service.beginStep("r", "r:1", 1);
  const prepare = service.span(
    { runId: "r", stepId: "r:1" },
    "context.prepare",
  );
  service.event(
    { runId: "r", stepId: "r:1", parentSpanId: prepare.id },
    "context.added",
    { count: 2 },
  );
  prepare.end();
  service.step({
    id: "r:1",
    runId: "r",
    index: 1,
    status: "completed",
    tools: [],
    content: "",
    error: null,
    finishReason: "stop",
    usage: null,
    createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  });
  const steps = store.observations
    .list("spans")
    .filter((span) => span.name === "agent.step");
  expect(steps).toHaveLength(1);
  expect(store.observations.get("spans", prepare.id)?.parentId).toBe(
    steps[0]?.id,
  );
  expect(
    store.observations
      .list("events")
      .find((event) => event.name === "context.added")?.spanId,
  ).toBe(prepare.id);
});
it("上下文增量比较不把旧无清单记录当成全部新增，也不把私有正文写入元数据", async () => {
  const { contextComponent, contextChanges } = await import(
    "../../packages/application/src/context-observation.js"
  );
  const before = [
    contextComponent("old", "history", "用户", "PRIVATE"),
    contextComponent("same", "tools", "read_file", "v1"),
  ];
  const after = [
    contextComponent("new", "current", "工具结果", "BODY"),
    contextComponent("same", "tools", "read_file", "v2"),
  ];
  const changed = contextChanges(after, before);
  expect(changed.added.map((item) => item.id)).toEqual(["new"]);
  expect(changed.changed.map((item) => item.id)).toEqual(["same"]);
  expect(changed.removed.map((item) => item.id)).toEqual(["old"]);
  expect(contextChanges(after).baselineKnown).toBe(false);
  expect(contextChanges(after).added).toEqual([]);
  expect(JSON.stringify(before)).not.toContain("PRIVATE");
});
