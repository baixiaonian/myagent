/** 可观测性公开协议：时间轴只含元数据，原始模型正文通过独立本机材料接口读取。 */
import type { ApiProtocol, ChatError, Usage } from "./index.js";
export type ModelPurpose = "agent" | "summary" | "memory" | "connection_test";
export interface ObservationScope {
  runId?: string;
  sessionId?: string;
  rootRunId?: string;
  agentId?: string;
  /** 展示名称由团队事实提供，不能由模型请求参数伪造发送者。 */
  agentName?: string;
  stepId?: string;
  jobId?: string;
  purpose?: ModelPurpose;
  callId?: string;
  parentSpanId?: string;
  invocationId?: string;
  attemptId?: string;
  processId?: string;
}
export type ObservationAttributes = Record<string, string | number | boolean>;
export interface TraceRecord {
  id: string;
  rootSpanId: string;
  scope: ObservationScope;
  startedAt: string;
  endedAt: string | null;
  status: string;
  previousTraceId: string | null;
  /** 进程崩溃后只知道最后观察时间，不能伪造 endedAt。 */
  lastObservedAt?: string;
  incomplete: boolean;
  /** 查询时从主 Run 投影的真实任务状态；不把执行段当成另一项用户任务。 */
  task?: { runId: string; status: string; error: ChatError | null };
}
export interface SpanRecord {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  scope: ObservationScope;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: string;
  attributes: ObservationAttributes;
  links: { traceId: string; spanId: string }[];
}
/** 独立节点详情的已有业务证据；不含 StoredStep.continuation，也不写入 Trace 属性。 */
export interface SpanEvidence {
  step?: import("./agent.js").RunStep;
  invocation?: import("./execution.js").ToolInvocation;
  messages?: import("./teams.js").TeamMessage[];
}
export interface TraceEventRecord {
  id: string;
  traceId: string;
  spanId: string;
  name: string;
  at: string;
  attributes: ObservationAttributes;
}
export interface ObservationSettings {
  revision: number;
  debug: boolean;
  retentionDays: number;
  startedAt: string;
}
export interface ModelCallRecord {
  id: string;
  traceId: string;
  spanId: string;
  scope: ObservationScope;
  connection: string;
  model: string;
  responseModel: string | null;
  protocol: ApiProtocol;
  startedAt: string;
  endedAt: string | null;
  status: string;
  sent: boolean;
  debug: boolean;
  firstChunkMs: number | null;
  firstTextMs: number | null;
  usage: Usage | null;
  usageError: string | null;
  responseId: string | null;
  serviceTier: string | null;
  price: ModelPrice | null;
  cost: string | null;
  currency: "USD" | "CNY" | null;
  unpricedReason: string | null;
}
export interface ModelPrice {
  id: string;
  revision: number;
  connection: string;
  model: string;
  currency: "USD" | "CNY";
  input: string;
  cacheRead: string | null;
  cacheWrite: string | null;
  output: string;
  source: string;
  verifiedAt: string;
  builtin: boolean;
  /** 无法确认分档条件时保留参考价，但禁止自动计算。 */
  condition?: string;
}
export interface CaptureRecord {
  id: string;
  callId: string;
  traceId: string;
  direction: "input" | "output";
  status: "capturing" | "complete" | "partial" | "purged";
  bytes: number;
  sha256: string | null;
  reason: string | null;
  contentType: string;
  createdAt: string;
}
export interface CapturePage {
  capture: CaptureRecord;
  text: string;
  nextOffset: number | null;
}
export interface UsageSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  unknownUsage: number;
  unpricedRequests: number;
  costs: Record<string, string>;
  /** 按已知输入 token 加权；缺少缓存字段的旧记录不能当作零命中。 */
  cache?: { readTokens: number; inputTokens: number; unknownRequests: number };
}
export interface AnonymousUsage extends UsageSummary {
  id: string;
  day: string;
  model: string;
  purpose: string;
}
export interface ObservationQuery {
  sessionId?: string;
  runId?: string;
  rootRunId?: string;
  model?: string;
  status?: string;
  purpose?: string;
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
}
export interface TracePage {
  trace: TraceRecord;
  spans: SpanRecord[];
  events: TraceEventRecord[];
  nextSpanOffset: number | null;
  nextEventOffset: number | null;
}
/** 总历时和并行工作量分开返回，累计工作量不能被当成用户等待时长。 */
export interface RunObservationSummary {
  runId: string;
  debug: boolean;
  usage: UsageSummary;
  wallMs: number | null;
  executionMs: number;
  unknownDurations: number;
  traces: string[];
  stages: {
    name: string;
    count: number;
    workMs: number;
    occupiedMs: number;
    selfMs: number;
  }[];
}
