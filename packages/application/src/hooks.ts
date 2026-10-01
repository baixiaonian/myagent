/** Hook 应用服务：配置时精确授权、Run 冻结、事件幂等与受控脚本执行；不调用模型或伪造工具 Step。 */
import {
  AppError,
  type ExecutionAttempt,
  type ExecutionReceipt,
  type HookConfigSave,
  type HookConfigView,
  type HookEvent,
  type HookExecution,
  type HookInput,
  type HookOutput,
  isActiveRun,
  type JsonValue,
  type McpConfigTarget,
  type Run,
  type ToolInvocation,
  type Workspace,
} from "@myagent/contracts";
import {
  type FrozenHook,
  type HookFilesPort,
  matchesHook,
  parseHookOutput,
} from "@myagent/extensions";
import {
  coversResource,
  createToolPreview,
  type DispatchRequest,
  type ExecutionContext,
  type ExecutionGateway,
  type ModelMessage,
  type ResultStorePort,
  raceSignal,
} from "@myagent/kernel";
import type {
  ChatStore,
  ExecutionStore,
  FinishRun,
  HookRecord,
  HookStore,
} from "@myagent/state";
import type { ExecutionCoordinator } from "./execution-coordinator.js";

const safe = (error: unknown) =>
  error instanceof AppError
    ? { code: error.code, message: error.message }
    : { code: "hook_failed", message: "Hook 执行失败，请查看执行日志。" };
export class HookService {
  observer?: import("@myagent/observability").ObserverPort;
  pluginPackageVersions?: () => string[];
  pluginHooks?: (
    runId: string,
    scope: "user" | "project",
  ) => import("@myagent/state").StoredHook[];
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly store: HookStore,
    private readonly chat: ChatStore,
    private readonly execution: ExecutionStore,
    private readonly files: HookFilesPort,
    private readonly gateway: ExecutionGateway,
    private readonly results: ResultStorePort,
    private readonly coordinator: ExecutionCoordinator,
    private readonly id: () => string,
  ) {}
  private fileId(target: McpConfigTarget) {
    return target.scope === "user"
      ? "user"
      : `project:${target.workspaceId ?? ""}`;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(operation);
    this.tail = next;
    return next;
  }
  private workspace(sessionId: string): Workspace {
    const session = this.chat.snapshot(sessionId).session;
    const workspace = this.execution.get(
      "workspaces",
      session.workspaceId ?? "",
    );
    if (!workspace)
      throw new AppError("workspace_required", "Hook 需要已绑定的项目目录。");
    return workspace;
  }
  /** 配置查看不执行脚本；落盘日志仅恢复准确版本的确认，不覆盖新的外部编辑。 */
  view(target: McpConfigTarget, text?: string): HookConfigView {
    const id = this.fileId(target);
    let state = this.store.get("files", id);
    try {
      const inspected = this.files.inspect(target, text);
      if (text === undefined && state?.staged) {
        if (
          inspected.text === state.staged.text &&
          inspected.version === state.staged.version
        )
          state = {
            id,
            target,
            trustedVersion: state.staged.version,
            trustedHooks: state.staged.hooks,
          };
        else {
          const { staged: _, ...previous } = state;
          state = previous;
        }
        this.store.put("files", state);
      }
      const pending =
        Boolean(inspected.document.hooks.length || state?.trustedVersion) &&
        inspected.version !== state?.trustedVersion;
      return {
        target,
        path: inspected.path,
        text: inspected.text,
        revision: inspected.revision,
        version: inspected.version,
        document: inspected.document,
        packages: inspected.hooks.map((h) => ({
          id: h.definition.id,
          version: h.package.version,
          interpreterPath: h.interpreterPath,
        })),
        pending,
        blocking: pending && Boolean(state?.trustedVersion),
        error: null,
      };
    } catch (error) {
      let raw = { path: "", text: "", revision: "" };
      try {
        raw = this.files.read(target);
      } catch {
        /* 路径本身不可访问时仅展示错误。 */
      }
      return {
        target,
        ...raw,
        text: text ?? raw.text,
        version: "",
        document: null,
        packages: [],
        pending: true,
        blocking: Boolean(state?.trustedVersion),
        error: safe(error).message,
      };
    }
  }
  /** 保存必须附带用户已预览的准确包版本；新配置预览本身不建立授权。 */
  save(input: HookConfigSave): Promise<HookConfigView> {
    return this.serial(async () => {
      const preview = this.files.inspect(input, input.text);
      if (!input.expectedVersion) return this.view(input, input.text);
      if (
        preview.revision !== input.expectedRevision ||
        preview.version !== input.expectedVersion
      )
        throw new AppError(
          "revision_conflict",
          "Hook 配置或脚本包已变化，请刷新预览。",
          409,
        );
      await this.files.capture(preview.hooks, new AbortController().signal);
      if (this.files.inspect(input, input.text).version !== preview.version)
        throw new AppError("revision_conflict", "脚本包在确认期间变化。", 409);
      const id = this.fileId(input),
        old = this.store.get("files", id);
      this.store.put("files", {
        id,
        target: {
          scope: input.scope,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        },
        trustedVersion: old?.trustedVersion ?? null,
        trustedHooks: old?.trustedHooks ?? [],
        staged: {
          text: input.text,
          version: preview.version,
          hooks: preview.hooks,
        },
      });
      // rename 后失败保留提交日志；下次查看/启动对账，不静默重新写入。
      await this.files.write(input, input.text, input.expectedRevision);
      return this.view(input);
    });
  }
  confirm(
    target: McpConfigTarget,
    revision: string,
    version: string,
  ): Promise<HookConfigView> {
    const current = this.files.inspect(target);
    return this.save({
      ...target,
      text: current.text,
      expectedRevision: revision,
      expectedVersion: version,
    });
  }
  /** 在创建 Run 的同一同步事务中执行；读取实际文件而不依赖监听缓存。 */
  initialize(run: Run, parentRunId?: string): void {
    if (parentRunId) {
      const source = this.store.get("runs", parentRunId);
      if (!source)
        throw new AppError("checkpoint_missing", "主任务扩展快照不存在。", 409);
      this.store.put("runs", {
        hooks: source.hooks,
        id: run.id,
        runId: run.id,
        sessionId: run.sessionId,
      });
      return;
    }
    const workspaceId = this.chat.snapshot(run.sessionId).session.workspaceId;
    const hooks: FrozenHook[] = [];
    for (const target of [
      { scope: "user" as const },
      ...(workspaceId ? [{ scope: "project" as const, workspaceId }] : []),
    ]) {
      const view = this.view(target),
        state = this.store.get("files", this.fileId(target));
      if (view.blocking)
        throw new AppError(
          "hook_confirmation_required",
          view.error ??
            "已经生效的 Hook 配置或脚本包已变化，请在 Hook 设置中确认准确版本。",
          409,
        );
      if (!view.pending && state) hooks.push(...state.trustedHooks);
      hooks.push(...(this.pluginHooks?.(run.id, target.scope) ?? []));
    }
    if (hooks.length && !workspaceId)
      throw new AppError(
        "workspace_required",
        "已启用 Hook 需要项目目录，请通过新对话选择目录。",
      );
    this.store.put("runs", {
      id: run.id,
      runId: run.id,
      sessionId: run.sessionId,
      hooks,
    });
  }
  /** 未解决副作用/活动进程存在时保守保留包；删除会话不删除用户脚本来源。 */
  collect(): void {
    if (
      this.execution.list("concerns").some((c) => !c.resolution) ||
      this.execution
        .list("processes")
        .some((p) => p.status === "running" || p.status === "unknown")
    )
      return;
    const keep = new Set(
      this.store
        .list("runs")
        .flatMap((r) => r.hooks.map((h) => h.package.version)),
    );
    for (const state of this.store.list("files"))
      for (const hook of [
        ...state.trustedHooks,
        ...(state.staged?.hooks ?? []),
      ])
        keep.add(hook.package.version);
    for (const version of this.pluginPackageVersions?.() ?? [])
      keep.add(version);
    this.files.collect(keep);
  }
  records(sessionId: string): HookExecution[] {
    this.chat.snapshot(sessionId);
    return this.store
      .list("events", { sessionId })
      .map(
        ({
          input: _,
          resources: _r,
          attemptId: _a,
          workerId: _w,
          applied: _p,
          ...record
        }) => record,
      );
  }
  hasToolHooks(runId: string, names: string[]): boolean {
    return (this.store.get("runs", runId)?.hooks ?? []).some((h) =>
      names.some(
        (n) =>
          matchesHook(h, "PreToolUse", n) || matchesHook(h, "PostToolUse", n),
      ),
    );
  }
  private current(runId: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!isActiveRun(this.chat.getRun(runId).status))
      throw new AppError("cancelled", "Hook 所属运行已结束。");
  }
  private pause(runId: string): never {
    this.execution.setRunStatus(runId, "waiting_reconciliation");
    throw new AppError(
      "execution_paused",
      "Hook 执行结果未知，需要先核对，不能重新执行。",
    );
  }
  private quarantine(record: HookRecord): void {
    const workspace = this.workspace(record.sessionId);
    this.execution.put("concerns", {
      id: record.id,
      workspaceId: workspace.id,
      sourceSessionId: record.sessionId,
      toolName: `Hook ${record.hookId}`,
      source: { kind: "local" },
      resources: record.resources,
      createdAt: record.createdAt,
    });
  }
  private checkConflicts(record: HookRecord): void {
    const concerns = this.execution
      .list("concerns")
      .filter((c) => !c.resolution)
      .concat(
        this.execution
          .list("invocations")
          .filter((i) => i.status === "unknown" && !i.resolution)
          .map((i) => ({
            id: i.id,
            workspaceId: "",
            sourceSessionId: i.sessionId,
            toolName: i.toolName,
            source: i.source,
            resources: i.resources,
            createdAt: i.createdAt,
          })),
      );
    if (
      concerns.some((c) =>
        c.resources.some((a) =>
          record.resources.some(
            (b) => coversResource(a, b) || coversResource(b, a),
          ),
        ),
      )
    )
      this.pause(record.runId);
  }
  private context(record: HookRecord): ExecutionContext {
    return {
      runId: record.runId,
      sessionId: record.sessionId,
      invocationId: record.id,
      stepId: "",
      workspace: this.workspace(record.sessionId),
    };
  }
  /** 回执、协议结果、注入标记与 SSE 共事务提交；取消后只保存执行事实，不应用迟到上下文。 */
  private async commit(
    record: HookRecord,
    receipt: ExecutionReceipt,
    signal?: AbortSignal,
  ): Promise<void> {
    const saved = await this.results.save(this.context(record), receipt.data);
    const data =
      receipt.data &&
      typeof receipt.data === "object" &&
      !Array.isArray(receipt.data)
        ? receipt.data
        : {};
    record.resultRef = saved.reference.id;
    record.logRef = typeof data.outputRef === "string" ? data.outputRef : null;
    record.status = receipt.outcome;
    record.error = receipt.error;
    record.endedAt = receipt.completedAt;
    if (receipt.outcome === "succeeded") {
      try {
        const output = parseHookOutput(String(data.stdout ?? ""), record.event);
        if (output.reason)
          output.reason = createToolPreview(output.reason, 4000, {
            reference: saved.reference.id,
          }).content;
        if (output.additionalContext)
          output.additionalContext = createToolPreview(
            output.additionalContext,
            8000,
            { reference: saved.reference.id },
          ).content;
        record.output = output;
        if (output.decision === "deny") record.status = "denied";
      } catch (error) {
        record.status = "failed";
        record.error = safe(error);
      }
    }
    if (signal?.aborted && record.status !== "unknown") {
      const timedOut =
        signal.reason instanceof Error &&
        (signal.reason.name === "TimeoutError" ||
          (signal.reason instanceof AppError &&
            signal.reason.code.endsWith("timeout")));
      record.status = timedOut ? "failed" : "cancelled";
      if (timedOut)
        record.error = {
          code: "hook_timeout",
          message: "Hook 执行超时，后续动作按事件故障策略处理。",
        };
      record.output = null;
    }
    record.applied =
      !signal?.aborted &&
      (record.status === "succeeded" || record.status === "denied");
    this.store.transaction(() => {
      this.store.put("events", record);
      if (record.status === "unknown") this.quarantine(record);
      const attempt =
        record.attemptId && this.execution.get("attempts", record.attemptId);
      if (attempt) {
        attempt.status = record.status === "unknown" ? "unknown" : "completed";
        attempt.endedAt = record.endedAt;
        this.execution.put("attempts", attempt);
      }
    });
  }
  private async execute(
    record: HookRecord,
    hook: FrozenHook,
    signal: AbortSignal,
    remainingMs?: number,
  ): Promise<void> {
    const context = this.context(record),
      workspace = context.workspace!;
    record.resources = await raceSignal(
      this.files.restore(hook, workspace, signal),
      signal,
    );
    this.checkConflicts(record);
    this.current(record.runId, signal);
    this.store.put("events", record);
    const release = await this.coordinator.acquire(
      record.runId,
      record.resources.map((r) => ({
        key: `${r.kind}:${r.target}`,
        mode: r.access === "read" ? "read" : "write",
      })),
      signal,
      { invocationId: record.id, toolName: "hook" },
    );
    try {
      await this.coordinator.slots.use(signal, async () => {
        this.checkConflicts(record);
        const resources = await raceSignal(
          this.files.restore(hook, workspace, signal),
          signal,
        );
        if (JSON.stringify(resources) !== JSON.stringify(record.resources))
          throw new AppError(
            "hook_changed",
            "Hook 资源身份在等待期间发生变化。",
            409,
          );
        this.current(record.runId, signal);
        const timeoutMs = Math.max(
          1,
          Math.min(hook.definition.timeoutMs, remainingMs ?? Infinity),
        );
        const attempt: ExecutionAttempt = {
          origin: "hook",
          id: this.id(),
          invocationId: record.id,
          sessionId: record.sessionId,
          runId: record.runId,
          status: "dispatching",
          workerId: null,
          startedAt: new Date().toISOString(),
          endedAt: null,
        };
        record.attemptId = attempt.id;
        record.status = "running";
        this.store.transaction(() => {
          this.store.put("events", record);
          this.execution.put("attempts", attempt);
        });
        const timeout = new AbortController(),
          abort = () => timeout.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const timer = setTimeout(
          () => timeout.abort(new AppError("hook_timeout", "Hook 执行超时。")),
          timeoutMs,
        );
        const effects = resources.some(
          (r) => r.kind === "network" || r.access === "write",
        );
        const request: DispatchRequest = {
          context,
          attemptId: attempt.id,
          timeoutMs,
          authorizedResources: resources,
          hook: {
            interpreterPath: hook.interpreterPath,
            entryPath: `${hook.package.runtimePath}/${hook.definition.entry}`,
            args: hook.definition.args,
            input: record.input as unknown as JsonValue,
            readOnlyPaths: [hook.package.runtimePath],
          },
          prepared: {
            descriptor: {
              name: "__hook_script",
              description: "私有 Hook 执行入口，不向模型注册",
              parameters: {},
              version: hook.version,
              source: { kind: "local" },
              effects: effects ? "write" : "read",
              concurrency: "exclusive",
              requiresWorkspace: true,
            },
            arguments: {},
            fingerprint: hook.version,
            resources,
            lockKeys: [],
          },
          onAccepted: async (workerId) => {
            const currentResources = await this.files.restore(
              hook,
              workspace,
              timeout.signal,
            );
            if (JSON.stringify(currentResources) !== JSON.stringify(resources))
              throw new AppError(
                "hook_changed",
                "Hook 派发前资源身份变化。",
                409,
              );
            this.current(record.runId, timeout.signal);
            if (
              !this.store
                .get("runs", record.runId)
                ?.hooks.some(
                  (h) => h.id === hook.id && h.version === hook.version,
                )
            )
              throw new AppError("hook_changed", "Hook 授权快照不存在。", 409);
            record.workerId = workerId;
            attempt.workerId = workerId;
            attempt.status = "accepted";
            attempt.acceptedAt = new Date().toISOString();
            this.store.transaction(() => {
              this.store.put("events", record);
              this.execution.put("attempts", attempt);
            });
          },
        };
        try {
          let receipt: ExecutionReceipt;
          try {
            receipt = await raceSignal(
              this.gateway.dispatch(request, timeout.signal),
              timeout.signal,
            );
          } catch (error) {
            if (timeout.signal.aborted)
              await this.gateway.cancelAttempt?.(attempt.id).catch(() => {});
            receipt = (await this.gateway.reconcile(
              attempt.id,
              attempt.workerId,
            )) ?? {
              attemptId: attempt.id,
              invocationId: record.id,
              outcome: attempt.status === "accepted" ? "unknown" : "failed",
              data: null,
              error: safe(error),
              effectsPossible: attempt.status === "accepted" && effects,
              completedAt: new Date().toISOString(),
            };
          }
          await this.commit(record, receipt, signal);
        } catch (error) {
          // 回执保存失败后保持 intent，登记隔离事实；不能让 Post 警告策略掩盖真实副作用未知。
          record.status = "unknown";
          record.error = safe(error);
          record.output = null;
          record.applied = false;
          this.store.transaction(() => {
            this.store.put("events", record);
            this.quarantine(record);
          });
          this.pause(record.runId);
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
      });
    } finally {
      release();
    }
  }
  async trigger(
    runId: string,
    event: HookEvent,
    trigger: string,
    signal: AbortSignal,
    tool?: ToolInvocation,
    remainingMs?: number,
  ): Promise<HookOutput> {
    const run = this.chat.getRun(runId),
      snapshot = this.store.get("runs", runId);
    const hooks =
      snapshot?.hooks.filter((h) => matchesHook(h, event, tool?.toolName)) ??
      [];
    const observed = hooks.length
      ? this.observer?.span(
          { runId, sessionId: run.sessionId },
          `hook.${event}`,
          { trigger },
        )
      : undefined;
    let observedOutcome = "succeeded";
    try {
      const started = Date.now();
      for (const hook of hooks) {
        this.current(runId, signal);
        const id = `${runId}:${trigger}:${hook.id}:${hook.version}`;
        let record = this.store.get("events", id);
        if (!record) {
          const workspace = this.workspace(run.sessionId),
            messages = this.chat.snapshot(run.sessionId).messages;
          const input: HookInput = {
            schemaVersion: 1,
            eventId: id,
            event,
            runId,
            sessionId: run.sessionId,
            workspace: { id: workspace.id, path: workspace.path },
            question:
              messages.find((m) => m.id === run.userMessageId)?.content ?? "",
          };
          if (tool)
            input.tool = {
              invocationId: tool.id,
              name: tool.toolName,
              arguments:
                tool.arguments.length <= 8000
                  ? (JSON.parse(tool.arguments) as JsonValue)
                  : {
                      preview: createToolPreview(tool.arguments, 8000).content,
                      sourceId: tool.id,
                      truncated: true,
                    },
              ...(event === "PostToolUse"
                ? {
                    result: {
                      outcome: tool.result?.outcome ?? "failed",
                      preview: tool.result?.modelContent ?? "",
                      resultRef: tool.result?.resultRef ?? null,
                    },
                  }
                : {}),
            };
          if (event === "RunEnd")
            input.outcome = {
              status: snapshot?.pendingOutcome?.status ?? "failed",
              error: snapshot?.pendingOutcome?.error ?? null,
              answer: createToolPreview(
                messages.find(
                  (m) => m.runId === run.id && m.role === "assistant",
                )?.content ?? "",
                8000,
              ).content,
            };
          record = {
            id,
            origin: "hook",
            sessionId: run.sessionId,
            runId,
            event,
            trigger,
            hookId: hook.definition.id,
            ...(hook.plugin ? { plugin: hook.plugin } : {}),
            scope: hook.scope,
            version: hook.version,
            status: "prepared",
            output: null,
            error: null,
            resultRef: null,
            logRef: null,
            resources: [],
            input,
            attemptId: null,
            workerId: null,
            applied: false,
            createdAt: new Date().toISOString(),
            endedAt: null,
          };
          this.store.put("events", record);
        }
        if (record.status === "unknown") {
          if (!this.execution.get("concerns", record.id)?.resolution)
            this.pause(runId);
          // 人工核对保留原 unknown；已核对也不重放脚本或把结果补造成成功。
          if (event === "RunStart")
            throw new AppError(
              "hook_unknown",
              "启动 Hook 结果未知，请开始新的任务。",
            );
          if (event === "PreToolUse")
            return {
              decision: "deny",
              reason: "前置 Hook 结果未知，本次工具调用不执行。",
            };
          continue;
        }
        if (record.status === "prepared") {
          try {
            const timeLeft = Math.max(
              1,
              Math.min(
                hook.definition.timeoutMs,
                remainingMs === undefined
                  ? Infinity
                  : remainingMs - (Date.now() - started),
              ),
            );
            const hookSignal = AbortSignal.any([
              signal,
              AbortSignal.timeout(timeLeft),
            ]);
            await this.execute(record, hook, hookSignal, timeLeft);
          } catch (error) {
            if (
              error instanceof AppError &&
              ["execution_paused", "execution_storage"].includes(error.code)
            )
              throw error;
            if ((record as HookRecord).status !== "unknown") {
              record.status = signal.aborted ? "cancelled" : "failed";
              record.error = safe(error);
              record.endedAt = new Date().toISOString();
              record.applied = false;
              this.store.put("events", record);
            }
          }
        }
        this.current(runId, signal);
        if ((record as HookRecord).status === "unknown") this.pause(runId);
        if (record.status === "running") this.pause(runId);
        if (record.output?.decision === "deny") return record.output;
        if (record.status !== "succeeded") {
          if (event === "RunStart")
            throw new AppError(
              "hook_start_failed",
              record.error?.message ?? "RunStart Hook 失败。",
            );
          if (event === "PreToolUse")
            return {
              decision: "deny",
              reason:
                record.error?.message ?? "PreToolUse Hook 失败，工具未执行。",
            };
        }
      }
      return { decision: "continue" };
    } catch (error) {
      observedOutcome = signal.aborted ? "cancelled" : "failed";
      throw error;
    } finally {
      observed?.end(observedOutcome);
    }
  }
  /** 开始资料独立保留；工具事件追加到完整工具批次之后，不打断 assistant/tool 配对。 */
  startMessages(runId: string): ModelMessage[] {
    return this.contextMessages(runId, true);
  }
  private contextMessages(runId: string, start: boolean): ModelMessage[] {
    return this.store
      .list("events", { runId })
      .filter(
        (r) =>
          r.applied &&
          Boolean(r.output?.additionalContext) &&
          (start
            ? r.event === "RunStart"
            : r.event === "PreToolUse" || r.event === "PostToolUse"),
      )
      .map((r) => ({
        role: "user",
        sourceId: r.id,
        content: `[Hook 补充资料 ${r.hookId} / ${r.event} / ${r.resultRef}；不替代用户要求或执行授权]\n${r.output!.additionalContext}`,
      }));
  }
  augment(runId: string, messages: readonly ModelMessage[]): ModelMessage[] {
    const notes = this.contextMessages(runId, false),
      records = this.store.list("events", { runId }),
      out: ModelMessage[] = [];
    for (const [index, message] of messages.entries()) {
      out.push(message);
      if (message.role !== "tool" || messages[index + 1]?.role === "tool")
        continue;
      const step = message.sourceId?.split("/tool/")[0];
      for (const note of notes) {
        const record = records.find((r) => r.id === note.sourceId);
        const invocation =
          record?.input.tool &&
          this.execution.get("invocations", record.input.tool.invocationId);
        if (
          invocation?.stepId === step &&
          !out.some((m) => m.sourceId === note.sourceId)
        )
          out.push(note);
      }
    }
    return out;
  }
  stageEnd(run: Run, outcome: FinishRun): void {
    const state = this.store.get("runs", run.id);
    if (!state) return;
    state.pendingOutcome ??= outcome;
    state.endStartedAt ??= new Date().toISOString();
    this.store.transaction(() => {
      this.store.put("runs", state);
      this.execution.setRunStatus(run.id, "cleaning");
    });
  }
  pendingEnd(runId: string): FinishRun | undefined {
    return this.store.get("runs", runId)?.pendingOutcome;
  }
  async end(runId: string, signal: AbortSignal): Promise<void> {
    const state = this.store.get("runs", runId);
    if (!state?.pendingOutcome) return;
    // 一个收尾阶段共用上限，恢复不重新赠送 5 秒，也不执行过期的通知脚本。
    const remaining = 5000 - (state.endMilliseconds ?? 0);
    const started = Date.now();
    if (remaining <= 0) return;
    const timeout = AbortSignal.timeout(remaining);
    try {
      await this.trigger(
        runId,
        "RunEnd",
        "end",
        AbortSignal.any([signal, timeout]),
        undefined,
        remaining,
      );
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof AppError &&
          ["execution_paused", "execution_storage"].includes(error.code))
      )
        throw error;
    } finally {
      state.endMilliseconds = Math.min(
        5000,
        (state.endMilliseconds ?? 0) + Date.now() - started,
      );
      this.store.put("runs", state);
    }
  }
  /** 启动只查已落盘回执，绝不执行新 Hook。 */
  async recover(): Promise<void> {
    for (const record of this.store.list("events")) {
      if (
        record.status !== "running" ||
        !record.attemptId ||
        !isActiveRun(this.chat.getRun(record.runId).status)
      )
        continue;
      const receipt = await this.gateway.reconcile(
        record.attemptId,
        record.workerId,
      );
      if (receipt) await this.commit(record, receipt);
      else {
        record.status = "unknown";
        record.error = {
          code: "hook_interrupted",
          message: "重启后缺少可靠 Hook 回执，请人工核对；不会自动重放。",
        };
        this.store.transaction(() => {
          this.store.put("events", record);
          this.quarantine(record);
        });
      }
    }
  }
}
