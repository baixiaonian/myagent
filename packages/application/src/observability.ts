/** 观测应用服务：生命周期、独立用量账本和原始材料索引；诊断故障不冒充业务失败或成功。 */
import { createHash, randomBytes } from "node:crypto";
import {
  AppError,
  type CaptureRecord,
  isActiveRun,
  type ModelCallRecord,
  type ModelPrice,
  type ObservationAttributes,
  type ObservationQuery,
  type ObservationScope,
  type Run,
  type RunObservationSummary,
  type RunStep,
  type SpanEvidence,
  type SpanRecord,
  type TracePage,
  type TraceRecord,
  type Usage,
  type UsageSummary,
} from "@myagent/contracts";
import { abortable, type ModelEvent, type ModelPort } from "@myagent/kernel";
import {
  BUILTIN_PRICES,
  type CaptureFilesPort,
  decimalUnits,
  emptyUsage,
  type ModelTransportObserver,
  mergeUsage,
  type ObservationHandle,
  type ObserverPort,
  priceUsage,
  type TraceExporterPort,
  unionDuration,
} from "@myagent/observability";
import type { ObservationStore, StoredSettings } from "@myagent/state";

const id = (bytes = 16) => randomBytes(bytes).toString("hex");
const now = () => new Date().toISOString();
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** 仅规范末尾斜线，不把自定义代理地址归类为官方。 */
const connection = (url: string) => url.replace(/\/+$/, "");
export class ObservabilityService
  implements ObserverPort, ModelTransportObserver
{
  readEvidence: (span: SpanRecord) => SpanEvidence = () => ({});
  /** 只接受该 Trace 内的真实节点；正文从业务事实按身份读取，不从调试文件重建历史。 */
  evidence(traceId: string, spanId: string): SpanEvidence {
    const span = this.store.get("spans", spanId);
    if (!span || span.traceId !== traceId)
      throw new AppError("not_found", "节点不存在或已清理。", 404);
    return this.readEvidence(span);
  }
  resolveScope: (scope: ObservationScope) => ObservationScope = (scope) =>
    scope;
  isRecoverable: (runId: string) => boolean = () => false;
  /** 装配层提供真实生命周期，只读；观测不得反向改变业务状态。 */
  runState: (id: string) => Pick<Run, "status" | "endedAt" | "error"> | null =
    () => null;
  private readonly waits = new Map<string, ObservationHandle>();
  private readonly active = new Map<string, ObservationHandle>();
  private readonly starts = new Map<string, number>();
  private readonly scopes = new Map<string, ObservationScope>();
  private readonly steps = new Map<
    string,
    { runId: string; handle: ObservationHandle }
  >();
  private closed = false;
  private ledgerFailed = false;
  private maintenanceAt = 0;
  private readonly messageSpans = new Map<
    string,
    { traceId: string; spanId: string }
  >();
  private readonly deletedSessions = new Set<string>();
  dropped = 0;
  constructor(
    readonly store: ObservationStore,
    readonly files: CaptureFilesPort,
    readonly exporter?: TraceExporterPort,
  ) {}
  /** 外发/诊断异常只能增加缺损计数；用量写入刻意不走这个吞错通道。 */
  private diagnostic(action: () => void): void {
    try {
      action();
    } catch {
      this.dropped++;
    }
  }
  private scope(input: ObservationScope): ObservationScope {
    return this.resolveScope(input);
  }
  private ensure(scope: ObservationScope): ObservationHandle {
    if (
      this.closed ||
      (scope.sessionId && this.deletedSessions.has(scope.sessionId))
    )
      throw new AppError("observation_closed", "执行段已停止。");
    const key =
      scope.runId ?? scope.jobId ?? `standalone:${scope.callId ?? id()}`;
    const existing = this.active.get(key);
    if (existing) return existing;
    const lifecycle = scope.runId ? this.runState(scope.runId) : null;
    if (lifecycle && !isActiveRun(lifecycle.status))
      throw new AppError(
        "observation_closed",
        "运行已经终结，迟到打点不能创建新 Trace。",
      );
    const parent =
      scope.rootRunId && scope.rootRunId !== scope.runId
        ? this.active.get(scope.rootRunId)
        : undefined;
    const previous = this.store
      .list("traces", scope.runId ? { runId: scope.runId } : {})
      .filter((t) =>
        scope.runId
          ? t.scope.runId === scope.runId
          : scope.jobId
            ? t.scope.jobId === scope.jobId
            : false,
      )
      .at(-1);
    const traceId = parent?.traceId ?? id(),
      spanId = id(8);
    if (!parent)
      this.store.put("traces", {
        id: traceId,
        rootSpanId: spanId,
        scope,
        startedAt: now(),
        endedAt: null,
        status: "running",
        previousTraceId: previous?.id ?? null,
        incomplete: false,
      });
    const record: SpanRecord = {
      id: spanId,
      traceId,
      parentId: parent?.id ?? null,
      name: scope.runId ? "agent.run" : (scope.purpose ?? "background"),
      scope,
      startedAt: now(),
      endedAt: null,
      durationMs: null,
      outcome: "running",
      attributes: {},
      links: previous
        ? [{ traceId: previous.id, spanId: previous.rootSpanId }]
        : [],
    };
    this.store.put("spans", record);
    const handle = this.handle(record, performance.now());
    this.active.set(key, handle);
    this.scopes.set(key, scope);
    return handle;
  }
  /** 计费账本出错后封闭新的付费请求；诊断采集仍独立失败。 */
  private ledger(action: () => void): void {
    try {
      action();
    } catch {
      this.ledgerFailed = true;
      throw new AppError(
        "storage_error",
        "用量账本写入失败，已停止新增模型请求。",
        500,
      );
    }
  }
  endScope(scope: ObservationScope, outcome: string): void {
    this.endRun(
      scope.runId ?? scope.jobId ?? `standalone:${scope.callId}`,
      outcome,
    );
  }
  message(
    scope: ObservationScope,
    messageId: string,
    phase: "queued" | "included" | "replied",
    attributes: ObservationAttributes,
  ): void {
    this.diagnostic(() => {
      const handle = this.span(scope, `team.message.${phase}`, {
        ...attributes,
        "myagent.message.id": messageId,
      });
      const old =
        this.messageSpans.get(messageId) ??
        this.store
          .list("spans")
          .find(
            (s) =>
              s.name === "team.message.queued" &&
              s.attributes["myagent.message.id"] === messageId,
          );
      if (old && phase !== "queued") {
        const saved = this.store.get("spans", handle.id);
        if (saved) {
          saved.links.push({
            traceId: old.traceId,
            spanId: "spanId" in old ? old.spanId : old.id,
          });
          this.store.put("spans", saved);
        }
      }
      if (phase === "queued")
        this.messageSpans.set(messageId, {
          traceId: handle.traceId,
          spanId: handle.id,
        });
      handle.end();
    });
  }
  /** 从准备上下文开始计时；同一进程恢复审批时复用句柄，不额外创建步骤。 */
  beginStep(runId: string, stepId: string, index: number): void {
    this.diagnostic(() => {
      if (!this.steps.has(stepId))
        this.steps.set(stepId, {
          runId,
          handle: this.span({ runId, stepId }, "agent.step", { index }),
        });
    });
  }
  step(step: RunStep): void {
    this.diagnostic(() => {
      let saved = this.steps.get(step.id);
      if (!saved) {
        saved = {
          runId: step.runId,
          handle: this.span(
            { runId: step.runId, stepId: step.id },
            "agent.step",
            { index: step.index },
          ),
        };
        this.steps.set(step.id, saved);
      }
      if (
        ["completed", "failed", "cancelled", "interrupted"].includes(
          step.status,
        )
      ) {
        saved.handle.end(step.status, {
          "myagent.tool.count": step.tools.length,
          "myagent.finish_reason": step.finishReason ?? "",
          "myagent.output.characters": step.content.length,
        });
        this.steps.delete(step.id);
      }
    });
  }
  beginRun(scope: ObservationScope): void {
    this.diagnostic(() => {
      const resolved = this.scope(scope);
      if (resolved.runId) {
        this.waits.get(resolved.runId)?.end("resumed");
        this.waits.delete(resolved.runId);
      }
      this.ensure(resolved);
    });
  }
  endRun(runId: string, outcome: string): void {
    this.diagnostic(() => {
      const handle = this.active.get(runId);
      if (!handle) return;
      // 审批只是同一进程中的等待：主句柄继续存在，成员不会因主 Agent 暂停而另建根 Trace。
      // 只有上下文持久暂停、需要核对、重启等真正执行段边界才关闭当前段。
      if (["waiting_agents", "waiting_approval"].includes(outcome)) {
        if (!this.waits.has(runId))
          this.waits.set(runId, this.span({ runId }, `run.${outcome}`));
        this.event({ runId }, `run.${outcome}`);
        this.store.flush?.();
        return;
      }
      this.waits.get(runId)?.end(outcome);
      this.waits.delete(runId);
      for (const [key, step] of this.steps)
        if (step.runId === runId) {
          step.handle.end(outcome);
          this.steps.delete(key);
        }
      const error = this.runState(runId)?.error;
      handle.end(
        outcome,
        error
          ? {
              "myagent.error.code": error.code,
              "myagent.error.message": error.message,
            }
          : {},
      );
      this.active.delete(runId);
      this.scopes.delete(runId);
      const trace = this.store.get("traces", handle.traceId);
      if (trace && trace.rootSpanId === handle.id) {
        trace.endedAt = now();
        trace.status = outcome;
        this.store.put("traces", trace);
      }
      this.store.flush?.();
    });
  }
  private handle(record: SpanRecord, started: number): ObservationHandle {
    let ended = false;
    return {
      id: record.id,
      traceId: record.traceId,
      end: (outcome = "succeeded", attributes = {}) => {
        if (ended) return;
        ended = true;
        this.diagnostic(() => {
          // 删除后迟到回调不能重新创建链路。
          const saved = this.store.get("spans", record.id);
          if (!saved) return;
          saved.endedAt = now();
          saved.durationMs = Math.max(0, performance.now() - started);
          saved.outcome = outcome;
          Object.assign(saved.attributes, attributes);
          this.store.put("spans", saved);
          this.exporter?.span(
            saved,
            this.store
              .list("events", { traceId: saved.traceId })
              .filter((e) => e.spanId === saved.id),
          );
        });
      },
    };
  }
  span(
    input: ObservationScope,
    name: string,
    attributes: ObservationAttributes = {},
  ): ObservationHandle {
    try {
      const scope = this.scope(input),
        parent = this.ensure(scope);
      const record: SpanRecord = {
        id: id(8),
        traceId: parent.traceId,
        parentId:
          scope.parentSpanId ??
          (name !== "agent.step" && scope.stepId
            ? this.steps.get(scope.stepId)?.handle.id
            : undefined) ??
          parent.id,
        name,
        scope,
        startedAt: now(),
        endedAt: null,
        durationMs: null,
        outcome: "running",
        attributes,
        links: [],
      };
      this.store.put("spans", record);
      return this.handle(record, performance.now());
    } catch {
      this.dropped++;
      return { id: "", traceId: "", end: () => {} };
    }
  }
  interval(
    scope: ObservationScope,
    name: string,
    start: string,
    end: string,
    outcome: string,
  ): void {
    this.diagnostic(() => {
      const parent = this.ensure(this.scope(scope));
      const record: SpanRecord = {
        id: id(8),
        traceId: parent.traceId,
        parentId: parent.id,
        name,
        scope,
        startedAt: start,
        endedAt: end,
        durationMs: Math.max(0, Date.parse(end) - Date.parse(start)),
        outcome,
        attributes: { "myagent.persisted_interval": true },
        links: [],
      };
      this.store.put("spans", record);
      this.exporter?.span(record, []);
    });
  }
  event(
    scope: ObservationScope,
    name: string,
    attributes: ObservationAttributes = {},
  ): void {
    this.diagnostic(() => {
      const resolved = this.scope(scope);
      const parent = this.ensure(resolved);
      this.store.put("events", {
        id: id(),
        traceId: parent.traceId,
        spanId:
          resolved.parentSpanId ??
          (resolved.stepId
            ? this.steps.get(resolved.stepId)?.handle.id
            : undefined) ??
          parent.id,
        name,
        at: now(),
        attributes,
      });
    });
  }
  /** 队列外层负责等待；本包装器只在名额就绪并开始迭代后创建计费意图。 */
  wrapModel(model: ModelPort, settings: StoredSettings): ModelPort {
    const owner = this;
    return {
      ...(model.estimateInput
        ? { estimateInput: model.estimateInput.bind(model) }
        : {}),
      async *stream(messages, signal, tools, context = {}) {
        signal.throwIfAborted();
        if (owner.ledgerFailed)
          throw new AppError(
            "storage_error",
            "用量账本故障尚未恢复，请重启服务核对。",
            500,
          );
        try {
          await owner.reclaimCaptureSpace();
        } catch {
          owner.dropped++;
        }
        signal.throwIfAborted();
        const callId = id(),
          scope = owner.scope({
            ...context,
            callId,
            purpose: context.purpose ?? "agent",
          });
        const span = owner.span(scope, "gen_ai.request", {
          "gen_ai.request.model": settings.model,
          "myagent.api_protocol": settings.apiProtocol,
        });
        const price =
          owner
            .prices()
            .find(
              (p) =>
                !p.builtin &&
                p.connection === connection(settings.baseUrl) &&
                p.model === settings.model,
            ) ??
          owner
            .prices()
            .find(
              (p) =>
                p.builtin &&
                p.connection === connection(settings.baseUrl) &&
                p.model === settings.model,
            ) ??
          null;
        const call: ModelCallRecord = {
          id: callId,
          traceId: span.traceId,
          spanId: span.id,
          scope,
          connection: connection(settings.baseUrl),
          model: settings.model,
          responseModel: null,
          protocol: settings.apiProtocol,
          startedAt: now(),
          endedAt: null,
          status: "running",
          sent: false,
          debug: owner.store.settings().debug,
          firstChunkMs: null,
          firstTextMs: null,
          usage: null,
          usageError: null,
          responseId: null,
          serviceTier: null,
          price,
          cost: null,
          currency: price?.currency ?? null,
          unpricedReason: "usage_missing",
        };
        owner.ledger(() => owner.store.put("calls", call));
        owner.starts.set(callId, performance.now());
        let outcome = "failed",
          terminal = false;
        let iterator: AsyncIterator<ModelEvent> | undefined;
        try {
          iterator = model
            .stream(messages, signal, tools, { ...scope, callId })
            [Symbol.asyncIterator]();
          while (true) {
            const next = await abortable(iterator.next(), signal);
            if (next.done) break;
            const saved = owner.store.get("calls", callId);
            if (!saved)
              throw new AppError("interrupted", "调用所属记录已删除。", 409);
            if (next.value.type === "text" && saved.firstTextMs === null) {
              saved.firstTextMs = performance.now() - owner.starts.get(callId)!;
              owner.ledger(() => owner.store.put("calls", saved));
            }
            if (next.value.type === "done") {
              terminal = ["stop", "tool_calls", "completed"].includes(
                next.value.finishReason,
              );
              outcome = terminal ? "succeeded" : "failed";
              owner.metadata(callId, { usage: next.value.usage });
            }
            yield next.value;
          }
          outcome = terminal ? "succeeded" : "failed";
        } catch (error) {
          outcome = signal.aborted ? "cancelled" : "failed";
          owner.event(scope, "model.error", {
            code: error instanceof AppError ? error.code : outcome,
          });
          throw error;
        } finally {
          void iterator?.return?.().catch(() => {});
          const saved = owner.store.get("calls", callId);
          try {
            if (saved) {
              saved.status = outcome;
              saved.endedAt = now();
              const cost = priceUsage(saved.usage, saved.price, saved);
              saved.cost = cost.cost;
              saved.unpricedReason = cost.reason;
              owner.ledger(() => owner.store.put("calls", saved));
            }
          } finally {
            owner.starts.delete(callId);
            span.end(outcome, {
              ...(saved?.usage
                ? {
                    "gen_ai.usage.input_tokens": saved.usage.inputTokens,
                    "gen_ai.usage.output_tokens": saved.usage.outputTokens,
                  }
                : {}),
              ...(saved?.responseModel
                ? { "gen_ai.response.model": saved.responseModel }
                : {}),
              ...(saved?.responseId
                ? { "gen_ai.response.id": saved.responseId }
                : {}),
              ...(saved?.firstChunkMs !== null &&
              saved?.firstChunkMs !== undefined
                ? { "myagent.first_chunk_ms": saved.firstChunkMs }
                : {}),
              ...(saved?.firstTextMs !== null &&
              saved?.firstTextMs !== undefined
                ? { "myagent.first_text_ms": saved.firstTextMs }
                : {}),
              "gen_ai.operation.name": "chat",
            });
            if (!scope.runId && scope.purpose !== "memory")
              owner.endStandalone(scope, span.traceId, outcome);
          }
        }
      },
    };
  }
  private endStandalone(
    scope: ObservationScope,
    traceId: string,
    outcome: string,
  ): void {
    this.diagnostic(() => {
      const key = scope.jobId ?? `standalone:${scope.callId}`,
        root = this.active.get(key);
      root?.end(outcome);
      this.active.delete(key);
      this.scopes.delete(key);
      const trace = this.store.get("traces", traceId);
      if (trace) {
        trace.endedAt = now();
        trace.status = outcome;
        this.store.put("traces", trace);
      }
      this.store.flush?.();
    });
  }
  sent(callId: string): void {
    const call = this.store.get("calls", callId);
    if (call) {
      call.sent = true;
      this.ledger(() => this.store.put("calls", call));
    } else throw new AppError("interrupted", "模型调用已撤销。", 409);
  }
  metadata(
    callId: string,
    metadata: {
      usage?: Usage | null;
      usageError?: string;
      model?: string;
      responseId?: string;
      serviceTier?: string;
    },
  ): void {
    const call = this.store.get("calls", callId);
    if (!call || call.status !== "running") return;
    const before = JSON.stringify(call);
    if (metadata.usage) call.usage = metadata.usage;
    else if (metadata.usage === null && !call.usage)
      call.usageError = metadata.usageError ?? "usage_missing";
    if (metadata.usageError) call.usageError = metadata.usageError;
    if (metadata.model) call.responseModel = metadata.model;
    if (metadata.responseId) call.responseId = metadata.responseId;
    if (metadata.serviceTier) call.serviceTier = metadata.serviceTier;
    if (before !== JSON.stringify(call))
      this.ledger(() => this.store.put("calls", call));
  }
  response(
    callId: string,
    status: number,
    contentType: string,
    requestId: string | null,
  ): void {
    this.diagnostic(() => {
      const call = this.store.get("calls", callId);
      if (!call) return;
      if (requestId) call.responseId = requestId;
      this.store.put("calls", call);
      const span = this.store.get("spans", call.spanId);
      if (span) {
        span.attributes["http.response.status_code"] = status;
        this.store.put("spans", span);
      }
      const capture = this.store
        .list("captures", { callId })
        .find((c) => c.direction === "output");
      if (capture) {
        capture.contentType = contentType;
        this.store.put("captures", capture);
      }
    });
  }
  chunk(callId: string): void {
    this.diagnostic(() => {
      const call = this.store.get("calls", callId);
      if (call && call.firstChunkMs === null) {
        call.firstChunkMs =
          performance.now() - (this.starts.get(callId) ?? performance.now());
        this.store.put("calls", call);
      }
    });
  }
  capture(callId: string, direction: "input" | "output") {
    try {
      const call = this.store.get("calls", callId);
      if (!call?.debug || this.closed) return null;
      const record: CaptureRecord = {
        id: id(),
        callId,
        traceId: call.traceId,
        direction,
        status: "capturing",
        bytes: 0,
        sha256: null,
        reason: null,
        contentType:
          direction === "input" ? "application/json" : "text/event-stream",
        createdAt: now(),
      };
      this.store.put("captures", record);
      try {
        return this.files.begin(record, (updated) => {
          if (!this.store.get("calls", callId)) return;
          const old = this.store.get("captures", record.id);
          if (!old || old.status === "purged") return;
          this.diagnostic(() =>
            this.store.put("captures", {
              ...updated,
              contentType: old.contentType,
            }),
          );
        });
      } catch {
        record.status = "partial";
        record.reason = "storage_error";
        this.diagnostic(() => this.store.put("captures", record));
        this.dropped++;
        return null;
      }
    } catch {
      this.dropped++;
      return null;
    }
  }
  settings() {
    return {
      ...this.store.settings(),
      dropped: this.dropped + (this.store.diagnostics?.().dropped ?? 0),
      ledgerFailed: this.ledgerFailed,
      exporter: this.exporter?.status?.() ?? null,
      exportEnabled: Boolean(this.exporter),
      captureBytes: this.store
        .list("captures")
        .filter((c) => c.status !== "purged")
        .reduce((n, c) => n + c.bytes, 0),
    };
  }
  configure(input: {
    requestId: string;
    expectedRevision: number;
    debug: boolean;
    retentionDays: number;
  }) {
    return this.store.operation(input.requestId, fingerprint(input), () => {
      const old = this.store.settings();
      if (old.revision !== input.expectedRevision)
        throw new AppError("revision_conflict", "观测设置已更新。", 409);
      if (
        !Number.isSafeInteger(input.retentionDays) ||
        input.retentionDays < 1 ||
        input.retentionDays > 3650
      )
        throw new AppError("invalid_settings", "保留期限须为 1–3650 天。");
      const value = {
        ...old,
        revision: old.revision + 1,
        debug: input.debug,
        retentionDays: input.retentionDays,
      };
      this.store.saveSettings(value);
      return value;
    });
  }
  prices() {
    return [...this.store.list("prices"), ...BUILTIN_PRICES];
  }
  savePrice(input: {
    requestId: string;
    expectedRevision: number;
    price: ModelPrice;
  }) {
    return this.store.operation(input.requestId, fingerprint(input), () => {
      const p = input.price,
        url = new URL(p.connection);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new AppError("invalid_price", "接口地址不能含认证信息。");
      for (const rate of [p.input, p.output, p.cacheRead, p.cacheWrite])
        if (rate !== null) decimalUnits(rate);
      const key = `manual:${fingerprint([connection(p.connection), p.model])}`;
      const old = this.store.get("prices", key);
      if ((old?.revision ?? 0) !== input.expectedRevision)
        throw new AppError("revision_conflict", "模型价格已更新。", 409);
      const value: ModelPrice = {
        id: key,
        revision: (old?.revision ?? 0) + 1,
        connection: connection(p.connection),
        model: p.model,
        currency: p.currency,
        input: p.input,
        output: p.output,
        cacheRead: p.cacheRead,
        cacheWrite: p.cacheWrite,
        source: "用户配置",
        verifiedAt: now(),
        builtin: false,
      };
      this.store.put("prices", value);
      return value;
    });
  }
  private matches(
    scope: ObservationScope,
    at: string,
    query: ObservationQuery,
  ): boolean {
    return (
      (!query.sessionId || scope.sessionId === query.sessionId) &&
      (!query.runId ||
        scope.runId === query.runId ||
        scope.rootRunId === query.runId) &&
      (!query.rootRunId || scope.rootRunId === query.rootRunId) &&
      (!query.purpose || scope.purpose === query.purpose) &&
      (!query.from || at >= query.from) &&
      (!query.to || at <= query.to)
    );
  }
  private present(trace: TraceRecord): TraceRecord {
    const runId = trace.scope.rootRunId ?? trace.scope.runId;
    const run = runId ? this.runState(runId) : null;
    return run && runId
      ? { ...trace, task: { runId, status: run.status, error: run.error } }
      : trace;
  }
  traces(query: ObservationQuery = {}) {
    const calls = this.store.list("calls");
    const all = this.store
      .list("traces")
      .filter(
        (t) =>
          this.matches(t.scope, t.startedAt, query) &&
          (!query.status || t.status === query.status) &&
          (!query.model ||
            calls.some((c) => c.traceId === t.id && c.model === query.model)),
      )
      .reverse();
    const offset = query.offset ?? 0,
      limit = Math.min(200, query.limit ?? 50);
    return {
      items: all
        .slice(offset, offset + limit)
        .map((trace) => this.present(trace)),
      nextOffset: all.length > offset + limit ? offset + limit : null,
    };
  }
  trace(traceId: string, spanOffset = 0, eventOffset = 0): TracePage {
    const trace = this.store.get("traces", traceId);
    if (!trace)
      throw new AppError("not_found", "追踪记录不存在或已过期。", 404);
    const spans = this.store.list("spans", {
        traceId,
        offset: spanOffset,
        limit: 201,
      }),
      events = this.store.list("events", {
        traceId,
        offset: eventOffset,
        limit: 201,
      });
    return {
      trace: this.present(trace),
      spans: spans.slice(0, 200).map((span) => {
        // 身份名称可从仍存在的团队事实补充；不重算旧时间、正文、调用关系或业务结论。
        try {
          return { ...span, scope: this.scope(span.scope) };
        } catch {
          return span;
        }
      }),
      events: events.slice(0, 200),
      nextSpanOffset: spans.length > 200 ? spanOffset + 200 : null,
      nextEventOffset: events.length > 200 ? eventOffset + 200 : null,
    };
  }
  call(callId: string) {
    const call = this.store.get("calls", callId);
    if (!call) throw new AppError("not_found", "模型调用不存在。", 404);
    return { call, captures: this.store.list("captures", { callId }) };
  }
  calls(query: ObservationQuery = {}) {
    return this.store
      .list(
        "calls",
        Object.fromEntries(
          Object.entries(query).filter(
            ([k, v]) =>
              ["sessionId", "model", "purpose", "from", "to"].includes(k) &&
              Boolean(v),
          ),
        ),
      )
      .filter(
        (c) =>
          this.matches(c.scope, c.startedAt, query) &&
          (!query.model || c.model === query.model) &&
          (!query.status || c.status === query.status),
      );
  }
  private callUsage(call: ModelCallRecord): UsageSummary {
    const summary = emptyUsage();
    if (!call.sent) return summary;
    summary.requests = 1;
    summary.inputTokens = call.usage?.inputTokens ?? 0;
    summary.outputTokens = call.usage?.outputTokens ?? 0;
    summary.unknownUsage = call.usage ? 0 : 1;
    const cached = call.usage?.cacheReadTokens;
    const validCache =
      typeof cached === "number" &&
      Number.isSafeInteger(cached) &&
      cached >= 0 &&
      cached <= summary.inputTokens;
    summary.cache = validCache
      ? {
          readTokens: cached,
          inputTokens: summary.inputTokens,
          unknownRequests: 0,
        }
      : { readTokens: 0, inputTokens: 0, unknownRequests: 1 };
    summary.unpricedRequests = call.cost === null ? 1 : 0;
    if (call.cost !== null && call.currency)
      summary.costs[call.currency] = call.cost;
    return summary;
  }
  usage(query: ObservationQuery = {}) {
    const total = emptyUsage(),
      groups = new Map<string, UsageSummary>();
    const add = (key: string, value: UsageSummary) => {
      mergeUsage(total, value);
      const group = groups.get(key) ?? emptyUsage();
      mergeUsage(group, value);
      groups.set(key, group);
    };
    for (const call of this.calls(query))
      add(
        `${call.startedAt.slice(0, 10)}|${call.model}|${call.scope.purpose ?? "agent"}`,
        this.callUsage(call),
      );
    if (!query.sessionId && !query.runId && !query.rootRunId && !query.status)
      for (const row of this.store.list("anonymous"))
        if (
          (!query.model || row.model === query.model) &&
          (!query.purpose || row.purpose === query.purpose) &&
          (!query.from || row.day >= query.from.slice(0, 10)) &&
          (!query.to || row.day <= query.to.slice(0, 10))
        )
          add(`${row.day}|${row.model}|${row.purpose}`, row);
    return {
      total,
      groups: [...groups].map(([key, value]) => ({ key, ...value })),
      startedAt: this.store.settings().startedAt,
    };
  }
  runSummary(runId: string): RunObservationSummary {
    const traces = this.store
      .list("traces")
      .filter((t) => t.scope.runId === runId || t.scope.rootRunId === runId);
    const spans = traces.flatMap((t) =>
      this.store.list("spans", { traceId: t.id }),
    );
    const interval = (s: SpanRecord): [number, number] => {
      const start = Date.parse(s.startedAt);
      return [
        start,
        start +
          (s.durationMs ??
            (s.outcome === "running" ? Math.max(0, Date.now() - start) : 0)),
      ];
    };
    const groups = new Map<string, SpanRecord[]>();
    for (const s of spans) {
      const values = groups.get(s.name) ?? [];
      values.push(s);
      groups.set(s.name, values);
    }
    const stages = [...groups].map(([name, values]) => ({
      name,
      count: values.length,
      workMs: values.reduce((n, s) => n + (s.durationMs ?? 0), 0),
      occupiedMs: unionDuration(values.map(interval)),
      selfMs: values.reduce((n, s) => {
        const [a, b] = interval(s);
        const children = spans
          .filter((c) => c.parentId === s.id)
          .map((c) => {
            const [x, y] = interval(c);
            return [Math.max(a, x), Math.min(b, y)] as const;
          });
        return n + Math.max(0, (s.durationMs ?? 0) - unionDuration(children));
      }, 0),
    }));
    const starts = traces.map((t) => Date.parse(t.startedAt)),
      ends = traces.map((t) =>
        Date.parse(t.endedAt ?? t.lastObservedAt ?? new Date().toISOString()),
      );
    return {
      runId,
      debug: this.store.settings().debug,
      usage: this.usage({ runId }).total,
      wallMs: traces.some((t) => t.incomplete)
        ? null
        : traces.length
          ? Math.max(0, Math.max(...ends) - Math.min(...starts))
          : null,
      executionMs: unionDuration(
        traces.map((t) => [
          Date.parse(t.startedAt),
          Date.parse(t.endedAt ?? t.lastObservedAt ?? new Date().toISOString()),
        ]),
      ),
      unknownDurations: spans.filter(
        (s) => s.durationMs === null && s.outcome !== "running",
      ).length,
      traces: traces.map((t) => t.id),
      stages,
    };
  }
  async capturePage(
    callId: string,
    captureId: string,
    offset = 0,
    limit = 65536,
  ) {
    this.call(callId);
    const capture = this.store.get("captures", captureId);
    if (!capture || capture.callId !== callId)
      throw new AppError("not_found", "原始材料不属于该调用。", 404);
    if (capture.status === "purged")
      throw new AppError("gone", "原始材料已清理。", 410);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 4
    )
      throw new AppError("invalid_cursor", "无效的材料分页参数。");
    const bytes = await this.files.read(
      captureId,
      offset,
      Math.min(limit, 1024 * 1024),
    );
    let count = bytes.length;
    // 分页不从 UTF-8 字符中间切开；原文件始终保留原字节，残缺采集的末尾另有状态说明。
    if (offset + count < capture.bytes && count > 0) {
      let start = count - 1;
      while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--;
      const lead = bytes[start]!,
        need = lead < 128 ? 1 : lead < 224 ? 2 : lead < 240 ? 3 : 4;
      if (count - start < need) count = start;
    }
    return {
      capture,
      text: new TextDecoder().decode(bytes.subarray(0, count)),
      nextOffset: offset + count < capture.bytes ? offset + count : null,
    };
  }
  async raw(callId: string, captureId: string): Promise<Uint8Array> {
    const { captures } = this.call(callId),
      capture = captures.find((c) => c.id === captureId);
    if (!capture || capture.status === "purged")
      throw new AppError("not_found", "原始材料不可读取。", 404);
    return this.files.read(captureId, 0, capture.bytes);
  }
  async clearCapture(
    callId: string,
    captureId: string,
    input: { requestId: string; expectedRevision: number },
  ) {
    const result = this.store.operation(
      input.requestId,
      fingerprint([callId, captureId, input]),
      () => {
        this.call(callId);
        const capture = this.store.get("captures", captureId);
        if (!capture || capture.callId !== callId)
          throw new AppError("not_found", "原始材料不存在。", 404);
        if (this.store.settings().revision !== input.expectedRevision)
          throw new AppError("revision_conflict", "观测设置已变化。", 409);
        if (capture.status === "capturing")
          throw new AppError(
            "capture_active",
            "请求仍在采集，结束后可清理。",
            409,
          );
        capture.status = "purged";
        capture.reason = "user_cleanup";
        this.store.put("captures", capture);
        return { id: capture.id };
      },
    );
    await this.files.remove(result.id);
    return result;
  }
  /** 与会话删除同一 SQLite 事务调用；返回待清理文件，事务提交后再删除。 */
  anonymizeSession(sessionId: string): string[] {
    return this.store.transaction(() => {
      this.deletedSessions.add(sessionId);
      const files: string[] = [];
      for (const call of this.store.list("calls", { sessionId })) {
        const key = fingerprint([
          call.startedAt.slice(0, 10),
          call.model,
          call.scope.purpose ?? "agent",
        ]);
        const row = this.store.get("anonymous", key) ?? {
          id: key,
          day: call.startedAt.slice(0, 10),
          model: call.model,
          purpose: call.scope.purpose ?? "agent",
          ...emptyUsage(),
        };
        mergeUsage(row, this.callUsage(call));
        this.store.put("anonymous", row);
        for (const capture of this.store.list("captures", {
          callId: call.id,
        })) {
          files.push(capture.id);
          this.store.remove("captures", capture.id);
        }
        this.store.remove("calls", call.id);
      }
      for (const trace of this.store.list("traces", { sessionId })) {
        for (const kind of ["spans", "events"] as const)
          for (const record of this.store.list(kind, { traceId: trace.id }))
            this.store.remove(kind, record.id);
        this.store.remove("traces", trace.id);
      }
      return files;
    });
  }
  async initialize(): Promise<void> {
    const reconciled = new Set<string>();
    for (const trace of this.store.list("traces")) {
      const run = trace.scope.runId ? this.runState(trace.scope.runId) : null;
      // 旧进程关闭可能把悬挂段写为 interrupted。只有业务实际结束在该段期间，才校正其终态；
      // 更早真正中断、后来恢复成功的段不得被追溯改成成功。
      const missedTerminal =
        trace.status === "interrupted" &&
        run?.endedAt &&
        ["succeeded", "failed", "cancelled"].includes(run.status) &&
        Date.parse(run.endedAt) >= Date.parse(trace.startedAt) &&
        (!trace.endedAt ||
          Date.parse(run.endedAt) <= Date.parse(trace.endedAt));
      if (!trace.endedAt || missedTerminal) {
        if (missedTerminal) reconciled.add(trace.id);
        trace.status =
          run && !isActiveRun(run.status) ? run.status : "interrupted";
        trace.incomplete = true;
        // 历史缺陷留下的 running 段以真实 Run 终态对账；结束时刻不明仍保持 null。
        if (
          run?.endedAt &&
          ["succeeded", "failed", "cancelled"].includes(run.status) &&
          Date.parse(run.endedAt) >= Date.parse(trace.startedAt)
        )
          trace.endedAt = run.endedAt;
        const points = [
          trace.startedAt,
          ...this.store
            .list("spans", { traceId: trace.id })
            .flatMap((s) => [s.startedAt, ...(s.endedAt ? [s.endedAt] : [])]),
          ...this.store.list("events", { traceId: trace.id }).map((e) => e.at),
        ];
        trace.lastObservedAt = points.sort().at(-1)!;
        this.store.put("traces", trace);
      }
    }
    for (const span of this.store.list("spans"))
      if (
        !span.endedAt ||
        (reconciled.has(span.traceId) && span.outcome === "interrupted")
      ) {
        const run = span.scope.runId ? this.runState(span.scope.runId) : null;
        span.outcome =
          run && !isActiveRun(run.status) ? run.status : "interrupted";
        span.endedAt = null;
        span.durationMs = null;
        span.attributes["myagent.end_time_unknown"] = true;
        this.store.put("spans", span);
      }
    for (const call of this.store.list("calls"))
      if (call.status === "running") {
        call.status = "interrupted";
        const cost = priceUsage(call.usage, call.price, call);
        call.cost = cost.cost;
        call.unpricedReason = cost.reason ?? "interrupted_usage_unknown";
        this.store.put("calls", call);
      }
    for (const capture of this.store.list("captures"))
      if (capture.status === "capturing") {
        capture.status = "partial";
        capture.reason = "interrupted";
        this.store.put("captures", capture);
      }
    try {
      await this.files.reconcile(
        new Set(
          this.store
            .list("captures")
            .filter((c) => c.status !== "purged")
            .map((c) => c.id),
        ),
      );
    } catch {
      this.dropped++;
    }
    for (const capture of this.store.list("captures"))
      if (capture.status !== "purged" && this.files.inspect) {
        try {
          const actual = await this.files.inspect(capture.id);
          // 完整材料重启后发生变化不能重新贴上“完整”标签；采集中断的材料按实际前缀重算。
          if (
            capture.status === "complete" &&
            (capture.bytes !== actual.bytes || capture.sha256 !== actual.sha256)
          ) {
            capture.status = "partial";
            capture.reason = "integrity_mismatch";
          }
          Object.assign(capture, actual);
        } catch {
          capture.status = "partial";
          capture.reason = "file_missing";
          capture.bytes = 0;
          capture.sha256 = null;
        }
        this.store.put("captures", capture);
      }
  }
  /** 为下一请求的两个材料预留空间；只回收已结束且不可恢复任务，绝不清理活动采集。 */
  async reclaimCaptureSpace(): Promise<void> {
    const stats = this.files.stats?.();
    if (
      !stats ||
      !this.store.settings().debug ||
      stats.bytes + Math.min(2 * stats.fileLimit, stats.limit) <= stats.limit
    )
      return;
    for (const capture of this.store.list("captures")) {
      const current = this.files.stats!();
      if (
        current.bytes + Math.min(2 * current.fileLimit, current.limit) <=
        current.limit
      )
        break;
      const call = this.store.get("calls", capture.callId);
      if (
        capture.status === "capturing" ||
        capture.status === "purged" ||
        call?.status === "running" ||
        (call?.scope.runId && this.isRecoverable(call.scope.runId))
      )
        continue;
      capture.status = "purged";
      capture.reason = "storage_budget";
      this.store.put("captures", capture);
      await this.files.remove(capture.id);
    }
  }
  async maintain(): Promise<void> {
    if (Date.now() - this.maintenanceAt < 60000) return;
    this.maintenanceAt = Date.now();
    const cutoff = Date.now() - this.store.settings().retentionDays * 86400000;
    for (const trace of this.store.list("traces"))
      if (
        trace.status !== "running" &&
        Date.parse(trace.endedAt ?? trace.lastObservedAt ?? trace.startedAt) <
          cutoff &&
        (!trace.scope.runId || !this.isRecoverable(trace.scope.runId))
      ) {
        for (const capture of this.store.list("captures", {
          traceId: trace.id,
        })) {
          await this.files.remove(capture.id);
          capture.status = "purged";
          capture.reason = "retention";
          this.store.put("captures", capture);
        }
        for (const kind of ["spans", "events"] as const)
          for (const record of this.store.list(kind, { traceId: trace.id }))
            this.store.remove(kind, record.id);
        this.store.remove("traces", trace.id);
      }
  }
  async close(): Promise<void> {
    for (const key of [...this.active.keys()]) this.endRun(key, "interrupted");
    this.closed = true;
    await this.files.close();
    this.store.flush?.();
    await this.exporter?.close();
  }
}
