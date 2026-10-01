/** 观测端口与纯计价：应用注入实现，不依赖 OTel、文件系统或数据库。 */
import type {
  CaptureRecord,
  ModelPrice,
  ObservationAttributes,
  ObservationScope,
  SpanRecord,
  TraceEventRecord,
  Usage,
  UsageSummary,
} from "@myagent/contracts";
export interface ObservationHandle {
  id: string;
  traceId: string;
  end(outcome?: string, attributes?: ObservationAttributes): void;
}
export interface ObserverPort {
  endScope?(scope: ObservationScope, outcome: string): void;
  message?(
    scope: ObservationScope,
    messageId: string,
    phase: "queued" | "included" | "replied",
    attributes: ObservationAttributes,
  ): void;
  interval?(
    scope: ObservationScope,
    name: string,
    start: string,
    end: string,
    outcome: string,
  ): void;
  span(
    scope: ObservationScope,
    name: string,
    attributes?: ObservationAttributes,
  ): ObservationHandle;
  event(
    scope: ObservationScope,
    name: string,
    attributes?: ObservationAttributes,
  ): void;
}
export interface CaptureSink {
  /** 拷贝入有界队列，不等待磁盘；溢出只终止采集，不终止业务流。 */
  write(bytes: Uint8Array): void;
  finish(reason?: string): Promise<void>;
}
export interface CaptureFilesPort {
  stats?(): { bytes: number; limit: number; fileLimit: number };
  inspect?(id: string): Promise<{ bytes: number; sha256: string }>;
  begin(
    record: CaptureRecord,
    update: (record: CaptureRecord) => void,
  ): CaptureSink;
  read(id: string, offset: number, bytes: number): Promise<Uint8Array>;
  remove(id: string): Promise<void>;
  reconcile(ids: ReadonlySet<string>): Promise<void>;
  close(): Promise<void>;
}
export interface ModelTransportObserver {
  capture(callId: string, direction: "input" | "output"): CaptureSink | null;
  sent(callId: string): void;
  response(
    callId: string,
    status: number,
    contentType: string,
    requestId: string | null,
  ): void;
  chunk(callId: string): void;
  metadata(
    callId: string,
    metadata: {
      usage?: Usage | null;
      usageError?: string;
      model?: string;
      responseId?: string;
      serviceTier?: string;
    },
  ): void;
}
export interface TraceExporterPort {
  status?(): { failedBatches: number; exportedSpans: number };
  span(record: SpanRecord, events: TraceEventRecord[]): void;
  close(): Promise<void>;
}
/** 合并重叠区间，计算真正占据的时间；两条并行请求绝不能相加冒充历时。 */
export function unionDuration(
  intervals: readonly (readonly [number, number])[],
): number {
  const sorted = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
    .slice()
    .sort((a, b) => a[0] - b[0]);
  let end = -Infinity,
    total = 0;
  for (const [a, b] of sorted) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}
/** 金额用十亿分之一货币单位，避免二进制浮点累计误差；单价最多九位小数。 */
export function decimalUnits(value: string): bigint {
  if (!/^\d{1,12}(?:\.\d{1,9})?$/.test(value))
    throw new Error("单价必须为最多九位小数的非负十进制数");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
}
export function decimalText(value: bigint): string {
  return `${value / 1_000_000_000n}.${(value % 1_000_000_000n).toString().padStart(9, "0")}`;
}
export function addMoney(a: string, b: string): string {
  return decimalText(decimalUnits(a) + decimalUnits(b));
}
export function priceUsage(
  usage: Usage | null,
  price: ModelPrice | null,
  facts?: {
    startedAt: string;
    endedAt: string | null;
    serviceTier: string | null;
  },
): { cost: string | null; reason: string | null } {
  if (!usage) return { cost: null, reason: "usage_missing" };
  if (!price) return { cost: null, reason: "price_missing" };
  if (
    [
      usage.inputTokens,
      usage.outputTokens,
      usage.totalTokens,
      usage.cacheReadTokens ?? 0,
      usage.cacheWriteTokens ?? 0,
      usage.reasoningTokens ?? 0,
    ].some((n) => !Number.isSafeInteger(n) || n < 0) ||
    (usage.reasoningTokens !== undefined &&
      usage.reasoningTokens > usage.outputTokens)
  )
    return { cost: null, reason: "usage_invalid" };
  if (
    price.builtin &&
    price.connection.includes("api.openai.com") &&
    (price.condition === "openai_context_272k"
      ? !["default", "flex", "fast", "priority"].includes(
          facts?.serviceTier ?? "",
        )
      : facts?.serviceTier !== "default")
  )
    return { cost: null, reason: "service_tier_unverified" };
  if (price.condition === "openai_context_272k") {
    // 官方普通端点：超过 272000 输入时整次请求进入长上下文档，不只给超出部分加价。
    const long = usage.inputTokens > 272000;
    const tier = facts?.serviceTier,
      numerator = tier === "fast" || tier === "priority" ? 2n : 1n,
      denominator = tier === "flex" ? 2n : 1n;
    const scale = (v: string, n: bigint, d = 1n) =>
      decimalText((decimalUnits(v) * n * numerator) / (d * denominator));
    price = {
      ...price,
      input: scale(price.input, long ? 2n : 1n),
      cacheRead:
        price.cacheRead === null
          ? null
          : scale(price.cacheRead, long ? 2n : 1n),
      cacheWrite:
        price.cacheWrite === null
          ? null
          : scale(price.cacheWrite, long ? 2n : 1n),
      output: scale(price.output, long ? 3n : 1n, long ? 2n : 1n),
    };
  } else if (price.condition === "deepseek_time") {
    // 已核实非高峰时段才自动套价；工作日高峰依赖未内置的节假日日历，明确保持未知。
    if (!facts?.endedAt) return { cost: null, reason: "billing_time_unknown" };
    const start = Date.parse(facts.startedAt),
      end = Date.parse(facts.endedAt);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end - start > 86400000
    )
      return { cost: null, reason: "billing_time_unknown" };
    for (let t = start; t <= end + 60000; t += 60000) {
      const d = new Date(Math.min(t, end)),
        day = d.getUTCDay(),
        hour = d.getUTCHours();
      if (
        day >= 1 &&
        day <= 5 &&
        ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
      )
        return { cost: null, reason: "peak_calendar_unverified" };
    }
    const half = (v: string) => decimalText(decimalUnits(v) / 2n);
    price = {
      ...price,
      input: half(price.input),
      output: half(price.output),
      cacheRead: price.cacheRead === null ? null : half(price.cacheRead),
    };
  } else if (price.condition) return { cost: null, reason: price.condition };
  const inputRate = decimalUnits(price.input),
    outputRate = decimalUnits(price.output);
  const readRate =
    price.cacheRead === null ? inputRate : decimalUnits(price.cacheRead);
  const writeRate =
    price.cacheWrite === null ? inputRate : decimalUnits(price.cacheWrite);
  // 不同费率必须知道分类，不能把缺失缓存字段当成零。
  if (readRate !== inputRate && usage.cacheReadTokens === undefined)
    return { cost: null, reason: "cache_read_usage_missing" };
  if (writeRate !== inputRate && usage.cacheWriteTokens === undefined)
    return { cost: null, reason: "cache_write_usage_missing" };
  const read = usage.cacheReadTokens ?? 0,
    write = usage.cacheWriteTokens ?? 0;
  if (read + write > usage.inputTokens)
    return { cost: null, reason: "usage_invalid" };
  const amount =
    BigInt(usage.inputTokens - read - write) * inputRate +
    BigInt(read) * readRate +
    BigInt(write) * writeRate +
    BigInt(usage.outputTokens) * outputRate;
  return { cost: decimalText((amount + 500_000n) / 1_000_000n), reason: null };
}
export const emptyUsage = (): UsageSummary => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  unknownUsage: 0,
  unpricedRequests: 0,
  costs: {},
  cache: { readTokens: 0, inputTokens: 0, unknownRequests: 0 },
});
export function mergeUsage(target: UsageSummary, source: UsageSummary): void {
  // 旧匿名汇总没有缓存明细；保留未知数量，不能从总 token 倒推出缓存命中。
  const previous = target.cache ?? {
    readTokens: 0,
    inputTokens: 0,
    unknownRequests: target.requests,
  };
  const incoming = source.cache ?? {
    readTokens: 0,
    inputTokens: 0,
    unknownRequests: source.requests,
  };
  target.cache = {
    readTokens: previous.readTokens + incoming.readTokens,
    inputTokens: previous.inputTokens + incoming.inputTokens,
    unknownRequests: previous.unknownRequests + incoming.unknownRequests,
  };
  target.requests += source.requests;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.unknownUsage += source.unknownUsage;
  target.unpricedRequests += source.unpricedRequests;
  for (const [currency, value] of Object.entries(source.costs))
    target.costs[currency] = addMoney(target.costs[currency] ?? "0", value);
}
/** 条件未适配的官方价只展示为参考项，绝不静默套价。 */
export const BUILTIN_PRICES: ModelPrice[] = [
  {
    id: "builtin:openai:gpt-5.3-codex",
    revision: 1,
    connection: "https://api.openai.com/v1",
    model: "gpt-5.3-codex",
    currency: "USD",
    input: "1.75",
    cacheRead: "0.175",
    cacheWrite: null,
    output: "14",
    source: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-09-29",
    builtin: true,
  },
  ...[
    ["gpt-6-astra", "10", "1", "12.5", "50"],
    ["gpt-6-sol", "2", "0.2", "2.5", "10"],
    ["gpt-6-luna", "0.1", "0.01", "0.125", "0.5"],
  ].map(([model, input, cacheRead, cacheWrite, output]) => ({
    id: `builtin:openai:${model}`,
    revision: 1,
    connection: "https://api.openai.com/v1",
    model: model!,
    currency: "USD" as const,
    input: input!,
    cacheRead: cacheRead!,
    cacheWrite: cacheWrite!,
    output: output!,
    source: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-09-29",
    builtin: true,
    condition: "openai_context_272k",
  })),
  ...[
    ["deepseek-flash", "0.3", "0.006", "1.2"],
    ["deepseek-v4-pro", "1.32", "0.044", "3.96"],
  ].map(([model, input, cacheRead, output]) => ({
    id: `builtin:deepseek:${model}`,
    revision: 1,
    connection: "https://api.deepseek.com",
    model: model!,
    currency: "USD" as const,
    input: input!,
    cacheRead: cacheRead!,
    cacheWrite: null,
    output: output!,
    source: "https://api-docs.deepseek.com/quick_start/pricing/",
    verifiedAt: "2026-09-29",
    builtin: true,
    condition: "deepseek_time",
  })),
];
