/** 观测仓储：用量不依赖 Trace 保留期；正文只保存引用，匿名化由应用协调事务。 */
import type {
  AnonymousUsage,
  CaptureRecord,
  ModelCallRecord,
  ModelPrice,
  ObservationSettings,
  SpanRecord,
  TraceEventRecord,
  TraceRecord,
} from "@myagent/contracts";
export interface ObservationRecords {
  traces: TraceRecord;
  spans: SpanRecord;
  events: TraceEventRecord;
  calls: ModelCallRecord;
  captures: CaptureRecord;
  prices: ModelPrice;
  anonymous: AnonymousUsage;
}
export interface ObservationFilter {
  traceId?: string;
  sessionId?: string;
  runId?: string;
  callId?: string;
  model?: string;
  purpose?: string;
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
}
export interface ObservationStore {
  flush?(): void;
  diagnostics?(): { dropped: number };
  get<K extends keyof ObservationRecords>(
    kind: K,
    id: string,
  ): ObservationRecords[K] | null;
  list<K extends keyof ObservationRecords>(
    kind: K,
    filter?: ObservationFilter,
  ): ObservationRecords[K][];
  put<K extends keyof ObservationRecords>(
    kind: K,
    value: ObservationRecords[K],
  ): void;
  remove(kind: keyof ObservationRecords, id: string): void;
  transaction<T>(operation: () => T): T;
  settings(): ObservationSettings;
  saveSettings(value: ObservationSettings): void;
  operation<T>(id: string, fingerprint: string, action: () => T): T;
}
