/** OTel 导出适配：本地身份映射成标准 Span，只有白名单元数据，导出失败不影响执行。 */
import { randomBytes } from "node:crypto";
import type { SpanRecord, TraceEventRecord } from "@myagent/contracts";
import type { TraceExporterPort } from "@myagent/observability";
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
export class OtelTraceExporter implements TraceExporterPort {
  private readonly provider: BasicTracerProvider;
  private seed: SpanRecord | undefined;
  private failedBatches = 0;
  private exportedSpans = 0;
  constructor(endpoint: string, headers: Record<string, string> = {}) {
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("无效的 OTLP 地址");
    const delegate = new OTLPTraceExporter({
      url: endpoint,
      headers,
      timeoutMillis: 2000,
    });
    const exporter: SpanExporter = {
      export: (spans, callback) =>
        delegate.export(spans, (result) => {
          if (result.code === 0) this.exportedSpans += spans.length;
          else this.failedBatches++;
          callback(result);
        }),
      shutdown: () => delegate.shutdown(),
      forceFlush: () => delegate.forceFlush(),
    };
    this.provider = new BasicTracerProvider({
      // startSpan 同步取得身份；此字段只在同步序列化期间设置，不承担业务异步上下文。
      idGenerator: {
        generateTraceId: () =>
          this.seed?.traceId ?? randomBytes(16).toString("hex"),
        generateSpanId: () => this.seed?.id ?? randomBytes(8).toString("hex"),
      },
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          maxQueueSize: 2048,
          maxExportBatchSize: 128,
          scheduledDelayMillis: 1000,
          exportTimeoutMillis: 2000,
        }),
      ],
    });
  }
  span(record: SpanRecord, events: TraceEventRecord[]): void {
    try {
      const parent = record.parentId
        ? trace.setSpanContext(ROOT_CONTEXT, {
            traceId: record.traceId,
            spanId: record.parentId,
            traceFlags: TraceFlags.SAMPLED,
          })
        : ROOT_CONTEXT;
      this.seed = record;
      const span = this.provider.getTracer("myagent", "1.0.0").startSpan(
        record.name,
        {
          startTime: new Date(record.startedAt),
          attributes: {
            ...record.attributes,
            "myagent.gen_ai.conventions":
              "e57c543b4889619eb2a05702471937db5119165d",
            "myagent.outcome": record.outcome,
            ...Object.fromEntries(
              Object.entries(record.scope).map(([k, v]) => [`myagent.${k}`, v]),
            ),
          },
          links: record.links.map((link) => ({
            context: { ...link, traceFlags: TraceFlags.SAMPLED },
          })),
        },
        parent,
      );
      this.seed = undefined;
      for (const event of events)
        span.addEvent(event.name, event.attributes, new Date(event.at));
      span.setStatus({
        code: ["failed", "unknown", "timeout"].includes(record.outcome)
          ? SpanStatusCode.ERROR
          : SpanStatusCode.UNSET,
      });
      span.end(new Date(record.endedAt ?? record.startedAt));
    } catch {
      this.seed = undefined; /* 外部接收失败不改变已保存的执行事实。 */
    }
  }
  status() {
    return {
      failedBatches: this.failedBatches,
      exportedSpans: this.exportedSpans,
    };
  }
  async close(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.provider.shutdown(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    } catch {
      /* 关闭限时，未送达数据不得宣称已送达。 */
    } finally {
      clearTimeout(timer);
    }
  }
}
