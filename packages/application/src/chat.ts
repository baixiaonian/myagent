/**
 * Agent 用例协调器：连接设置快照、完整历史、Run 事务和统一自主循环。
 * 活动取消句柄只存在于本进程；历史与事件归 ChatStore，模型通信经 Kernel 的 ModelPort。
 * 增量先缓冲再持久化，终态立即提交；删除、停止和关闭共享同一套生命周期。
 */
import {
  AGENT_LIMITS,
  type AgentLimits,
  AppError,
  type ContextResumeInput,
  isActiveRun,
  type JsonValue,
  LIMITS,
  type RegenerateInput,
  type Run,
  type RunAccepted,
  type RunInput,
} from "@myagent/contracts";
import {
  type AgentCheckpoint,
  defaultContextBuilder,
  type ModelMessage,
  type ModelPort,
  runAgent,
  type ToolExecutor,
} from "@myagent/kernel";
import {
  type ChatStore,
  contextBeforeQuestion,
  type FinishRun,
  type StoredSettings,
} from "@myagent/state";
import { connectionIdentity, executionHistory } from "./context.js";
import type { ContextService } from "./context-service.js";
import type { HookService } from "./hooks.js";
import type { PluginService } from "./plugins.js";
import type { SettingsService } from "./settings.js";
import type { SkillService } from "./skills.js";
import type { TeamService } from "./teams.js";
import type { ToolService } from "./tools.js";
export class ChatService {
  observations?: import("./observability.js").ObservabilityService;
  team?: TeamService;
  executing(runId: string) {
    return this.active.has(runId);
  }
  private finish(runId: string, outcome: FinishRun) {
    const commit = () => this.store.finishRun(runId, outcome);
    if (this.team) this.team.finish(this.store.getRun(runId), outcome, commit);
    else commit();
    // 暂停时没有活动 launch 协程，取消也必须在真实终态提交后关闭观测句柄。
    this.observations?.endRun(runId, this.store.getRun(runId).status);
  }
  /** 可信装配点的能力准备；模式取 Run 快照，恢复也不采用页面的下一轮偏好。 */
  prepareExecution?: (run: Run, signal: AbortSignal) => Promise<void>;
  private closing = false;
  // 只登记本进程真正执行的 Run；数据库中的 running 可能是上次崩溃遗留，需启动恢复。
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  constructor(
    readonly store: ChatStore,
    private readonly settings: SettingsService,
    private readonly timeoutMs = 120000,
    private readonly tools: ToolExecutor = {
      definitions: [],
      execute: async () => null,
    },
    private readonly limits: Partial<AgentLimits> = {},
    readonly toolSystem?: ToolService,
    readonly contexts?: ContextService,
    private readonly memoryLifecycle?: {
      deleteSession(id: string): Promise<void>;
    },
    readonly skills?: SkillService,
    readonly hooks?: HookService,
    readonly plugins?: PluginService,
  ) {}
  // 返回已落库的 Run 和快照；实际模型请求在微任务中启动，因此 HTTP 不等待整段回答。
  // 同 requestId 先查历史：即使原运行已结束、设置已改变，也必须返回原提交结果。
  start(
    sessionId: string,
    input: RunInput | RegenerateInput,
    kind: "send" | "regenerate" = "send",
    parentRunId?: string,
  ): RunAccepted {
    if (this.closing)
      throw new AppError("unavailable", "本地服务正在关闭。", 503);
    // 成员继承主任务的模式，不能通过任务正文或自带输入扩大权限。
    const executionMode = parentRunId
      ? (this.store.getRun(parentRunId).executionMode ?? "standard")
      : (input.executionMode ?? "standard");
    if (!["standard", "full_access"].includes(executionMode))
      throw new AppError("invalid_execution_mode", "无效的执行权限模式。");
    const content = "content" in input ? input.content.trim() : "";
    // 指纹包含操作、内容和提交时版本；禁止把同一幂等键用于不同请求。
    const fingerprint = JSON.stringify([
      kind,
      input.skillIds ? [...new Set(input.skillIds)].sort() : null,
      content,
      input.expectedRevision,
      "confirmSideEffects" in input ? input.confirmSideEffects : false,
      // 保持旧标准模式请求的幂等指纹；完全访问作为不同操作不可复用旧请求 ID。
      ...(executionMode === "full_access" ? [executionMode] : []),
    ]);
    const previous = this.store.findRequest(sessionId, input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError(
          "idempotency_conflict",
          "请求标识已经用于另一条操作。",
          409,
        );
      return { run: previous, snapshot: this.store.snapshot(sessionId) };
    }
    const snapshot = this.store.snapshot(sessionId);
    if (
      kind === "regenerate" &&
      (this.toolSystem?.hasSideEffectsForQuestion(
        sessionId,
        snapshot.messages.findLast((message) => message.role === "user")?.id ??
          "",
      ) ||
        this.team?.hasSideEffects(
          sessionId,
          snapshot.messages.findLast((message) => message.role === "user")
            ?.id ?? "",
        )) &&
      !("confirmSideEffects" in input && input.confirmSideEffects)
    )
      throw new AppError(
        "side_effect_confirmation",
        "本轮执行过可能改变文件或外部系统的工具。请确认基于当前状态重新运行，旧操作不会自动撤销。",
        409,
      );
    // 此处读取配置并创建专属模型实例；随后修改设置不会影响该次运行持有的连接。
    if (this.team?.member(sessionId) && !parentRunId)
      throw new AppError("agent_internal", "请通过主对话协调成员。", 403);
    const inherited = parentRunId
      ? this.toolSystem?.options.store.get("checkpoints", parentRunId)?.settings
      : undefined;
    if (parentRunId && !inherited)
      throw new AppError("checkpoint_missing", "主任务连接快照不存在。", 409);
    const { model, settings } = this.settings.model(inherited);
    const question =
      kind === "send"
        ? content
        : snapshot.messages.findLast((message) => message.role === "user")
            ?.content;
    if (!question)
      throw new AppError("invalid_input", "没有可以重新生成的问题。");
    const lastUser = snapshot.messages.findLast(
      (message) => message.role === "user",
    );
    // 重新生成时截取原问题之前的历史，防止旧答案或原问题再次进入当前问题上下文。
    const history =
      kind === "regenerate" && lastUser
        ? contextBeforeQuestion(snapshot.messages, lastUser.id)
        : snapshot.messages;
    if (!question.trim() || question.length > LIMITS.inputCharacters)
      throw new AppError("invalid_input", "请输入 1–8000 字符的问题。");
    const identity = connectionIdentity(settings);
    const modelHistory = executionHistory(
      this.store,
      history,
      identity,
      (id, records) => {
        const withHooks = this.hooks?.augment(id, records) ?? [...records];
        return this.team?.augment(id, withHooks) ?? withHooks;
      },
    );
    const current: ModelMessage[] = [{ role: "user", content: question }];
    const limits = {
      ...AGENT_LIMITS,
      ...(this.contexts ? { historyTurns: 3 } : {}),
      modelTimeoutMs: this.timeoutMs,
      ...this.limits,
    };
    let instructions = [
      settings.systemPrompt,
      this.contexts ? "" : (this.toolSystem?.effectsContext(sessionId) ?? ""),
    ]
      .filter(Boolean)
      .join("\n\n");
    const context = this.contexts
      ? { trimmed: false }
      : defaultContextBuilder.build({
          instructions,
          history: modelHistory,
          current,
          tools: this.tools.definitions,
          limits,
        });
    // 上下文校验成功后才建 Run；事务同时保存问题、候选回答和开始事件，避免半条会话。
    const beginRun = () =>
      this.store.beginRun({
        sessionId,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        fingerprint,
        kind,
        content: question,
        ...(parentRunId
          ? {
              origin: {
                kind: "agent" as const,
                agentId:
                  this.team?.store.get("messages", input.requestId)?.from ??
                  "main",
                rootRunId: parentRunId,
                messageId: input.requestId,
              },
            }
          : {}),
        executionMode,
        model: settings.model,
        apiProtocol: settings.apiProtocol,
        contextTrimmed: context.trimmed,
      });
    const create = () => {
      const run = beginRun();
      this.team?.initialize(run, parentRunId);
      this.plugins?.initialize(run, parentRunId);
      this.hooks?.initialize(run, parentRunId);
      if (parentRunId) instructions += this.team?.instructions(run.id) ?? "";
      this.contexts?.initialize(
        run,
        settings,
        this.limits.contextCharacters ?? null,
        false,
        parentRunId,
      );
      current[0] = {
        role: "user",
        content: question,
        sourceId: run.userMessageId,
      } as ModelMessage;
      if (parentRunId) current.push(...(this.team?.seed(run.id) ?? []));
      this.toolSystem?.options.store.put("checkpoints", {
        id: run.id,
        runId: run.id,
        sessionId,
        settings,
        limits,
        instructions,
        current: JSON.parse(JSON.stringify(current)) as JsonValue,
        history: this.contexts
          ? []
          : (JSON.parse(JSON.stringify(modelHistory)) as JsonValue),
        runtime: null,
        loadedTools: [],
        activeMilliseconds: 0,
        updatedAt: new Date().toISOString(),
      });
      this.toolSystem?.initializeRunTools(run.id, sessionId);
      this.skills?.initialize(
        run.id,
        question,
        input.skillIds,
        kind === "regenerate" ? lastUser?.id : undefined,
      );
      return run;
    };
    const run = this.toolSystem
      ? this.toolSystem.options.store.transaction(create)
      : this.contexts
        ? this.contexts.store.transaction(create)
        : create();
    this.launch(
      run,
      model,
      settings,
      current,
      modelHistory,
      instructions,
      limits,
    );
    return { run, snapshot: this.store.snapshot(sessionId) };
  }
  /** 手动恢复只从已保存检查点继续；连接取原快照，不使用后来保存的新模型配置。 */
  async resume(
    runId: string,
    input: ContextResumeInput = {},
  ): Promise<RunAccepted> {
    const run = this.store.getRun(runId);
    this.team?.resume(runId);
    if (
      input.requestId &&
      input.contextAction &&
      this.contexts?.store.get("runs", runId)?.resumeRequests[input.requestId]
    ) {
      this.contexts.resume(runId, input, this.store.settings());
      return { run, snapshot: this.store.snapshot(run.sessionId) };
    }
    if (this.active.has(runId)) {
      if (
        [
          "waiting_approval",
          "waiting_reconciliation",
          "waiting_context",
        ].includes(run.status)
      ) {
        await this.active.get(runId)?.done;
        return this.resume(runId, input);
      }
      return { run, snapshot: this.store.snapshot(run.sessionId) };
    }
    if (this.closing || !this.toolSystem || !isActiveRun(run.status))
      throw new AppError("not_resumable", "该运行不可继续。", 409);
    const checkpoint = this.toolSystem.options.store.get("checkpoints", runId);
    if (!checkpoint)
      throw new AppError("checkpoint_missing", "旧运行没有可恢复检查点。", 409);
    if (
      this.hooks?.store
        .list("events", { runId })
        .some(
          (e) =>
            e.status === "unknown" &&
            !this.toolSystem?.options.store.get("concerns", e.id)?.resolution,
        )
    )
      throw new AppError(
        "reconciliation_required",
        "请先核对结果未知的 Hook。",
        409,
      );
    if (
      this.toolSystem.options.store
        .list("invocations", { runId })
        .some((item) => item.status === "unknown" && !item.resolution)
    )
      throw new AppError(
        "reconciliation_required",
        "请先处理执行结果未知的操作。",
        409,
      );
    if (
      this.toolSystem.options.store
        .list("approvals", { runId })
        .some((item) => item.status === "pending")
    )
      throw new AppError("approval_required", "请先处理待批准操作。", 409);
    if (this.contexts) {
      const contexts = this.contexts;
      contexts.store.transaction(() => {
        // v5 尚无根规则快照；升级恢复不能把今天的文件伪装成旧 Run 开始时的规则。
        if (!contexts.store.get("runs", run.id)) {
          checkpoint.instructions = checkpoint.settings.systemPrompt;
          contexts.initialize(
            run,
            checkpoint.settings,
            checkpoint.limits.contextCharacters || null,
            true,
          );
          this.toolSystem?.options.store.put("checkpoints", checkpoint);
        }
      });
      if (run.status === "waiting_context" && !input.contextAction)
        throw new AppError(
          "context_action_required",
          "请选择重试整理或应用最新容量后继续。",
          409,
        );
      if (!this.contexts.resume(runId, input, this.store.settings()))
        return {
          run: this.store.getRun(runId),
          snapshot: this.store.snapshot(run.sessionId),
        };
    }
    // 崩溃可能落在最终 Step 提交与 cleaning 意图之间；从真实完成记录重建收尾，不再请求模型。
    const completion = this.store.getSteps(runId);
    const finalStep = completion.at(-1)?.step;
    const savedRuntime =
      checkpoint.runtime as unknown as AgentCheckpoint | null;
    if (
      this.hooks?.store.get("runs", runId) &&
      !this.hooks.pendingEnd(runId) &&
      finalStep?.status === "completed" &&
      !finalStep.tools.length &&
      !savedRuntime?.pendingStep &&
      !savedRuntime?.completionPending
    ) {
      const usage = completion.every((r) => r.step.usage !== null)
        ? completion.reduce(
            (sum, r) => ({
              inputTokens: sum.inputTokens + (r.step.usage?.inputTokens ?? 0),
              outputTokens:
                sum.outputTokens + (r.step.usage?.outputTokens ?? 0),
              totalTokens: sum.totalTokens + (r.step.usage?.totalTokens ?? 0),
            }),
            { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          )
        : null;
      this.hooks.stageEnd(run, {
        status: "succeeded",
        finishReason: finalStep.finishReason,
        usage,
        error: null,
      });
    }
    const pendingEnd = this.hooks?.pendingEnd(runId);
    if (pendingEnd) {
      const controller = new AbortController();
      const done = Promise.resolve()
        .then(async () => {
          this.toolSystem!.options.store.setRunStatus(runId, "cleaning");
          if (!(await this.toolSystem!.finish(runId))) {
            this.toolSystem!.options.store.setRunStatus(
              runId,
              "waiting_reconciliation",
            );
            throw new AppError("execution_paused", "清理结果未知，请先核对。");
          }
          await this.hooks?.end(runId, controller.signal);
          if (!(await this.toolSystem!.finish(runId))) {
            this.toolSystem!.options.store.setRunStatus(
              runId,
              "waiting_reconciliation",
            );
            throw new AppError("execution_paused", "Hook 清理需要核对。");
          }
          controller.signal.throwIfAborted();
          this.store.finishRun(runId, pendingEnd);
        })
        .catch((error) => {
          if (controller.signal.aborted)
            this.finish(runId, {
              status: "cancelled",
              finishReason: null,
              usage: null,
              error: { code: "cancelled", message: "已停止收尾。" },
            });
          else if (
            !(error instanceof AppError && error.code === "execution_paused")
          )
            this.toolSystem!.options.store.setRunStatus(runId, "recoverable");
        })
        .finally(() => this.active.delete(runId));
      this.active.set(runId, { controller, done });
      return {
        run: this.store.getRun(runId),
        snapshot: this.store.snapshot(run.sessionId),
      };
    }
    const runtime = checkpoint.runtime as unknown as
      | AgentCheckpoint
      | undefined;
    const records = this.store.getSteps(runId);
    const last = records.at(-1)?.step;
    if (
      !runtime?.pendingStep &&
      !runtime?.completionPending &&
      last?.status === "completed" &&
      !last.tools.length
    ) {
      if (!(await this.toolSystem.finish(runId)))
        throw new AppError("cleanup_unknown", "尚未确认进程清理完成。", 409);
      const usage = records.every((record) => record.step.usage !== null)
        ? records.reduce(
            (sum, record) => ({
              inputTokens:
                sum.inputTokens + (record.step.usage?.inputTokens ?? 0),
              outputTokens:
                sum.outputTokens + (record.step.usage?.outputTokens ?? 0),
              totalTokens:
                sum.totalTokens + (record.step.usage?.totalTokens ?? 0),
            }),
            { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          )
        : null;
      this.finish(runId, {
        status: "succeeded",
        finishReason: last.finishReason,
        usage,
        error: null,
      });
      return {
        run: this.store.getRun(runId),
        snapshot: this.store.snapshot(run.sessionId),
      };
    }
    if (
      runtime &&
      !runtime.pendingStep &&
      last &&
      last.index >= runtime.nextIndex
    )
      runtime.nextIndex = last.index + 1;
    const { model } = this.settings.model(checkpoint.settings);
    this.toolSystem.options.store.setRunStatus(runId, "running");
    this.launch(
      run,
      model,
      checkpoint.settings,
      checkpoint.current as unknown as ModelMessage[],
      checkpoint.history as unknown as ModelMessage[][],
      checkpoint.instructions,
      checkpoint.limits,
      runtime,
    );
    return {
      run: this.store.getRun(runId),
      snapshot: this.store.snapshot(run.sessionId),
    };
  }
  private launch(
    run: Run,
    model: ModelPort,
    settings: StoredSettings,
    current: ModelMessage[],
    modelHistory: ModelMessage[][],
    instructions: string,
    limits: AgentLimits,
    resume?: AgentCheckpoint,
  ): void {
    this.observations?.beginRun({
      runId: run.id,
      sessionId: run.sessionId,
      purpose: "agent",
    });
    for (const reference of this.plugins?.references(run.id) ?? [])
      this.observations?.event(
        { runId: run.id, sessionId: run.sessionId },
        "plugin.version",
        {
          pluginId: reference.pluginId,
          version: reference.version,
          configurationVersion: reference.configurationVersion,
        },
      );
    model = this.team?.model(run.id, model) ?? model;
    const identity = connectionIdentity(settings);
    const started = Date.now();
    const initialElapsed =
      this.toolSystem?.options.store.get("checkpoints", run.id)
        ?.activeMilliseconds ?? 0;
    const executionTools =
      this.toolSystem?.forRun(run.id, run.sessionId) ?? this.tools;
    const controller = new AbortController();
    // 先登记取消句柄，再从微任务开始实际模型请求。
    const done = Promise.resolve().then(async () => {
      // 外层成员创建事务若已回滚，微任务不得为未提交的 Run 产生费用。
      try {
        this.store.getRun(run.id);
      } catch {
        this.active.delete(run.id);
        return;
      }
      let buffer = "";
      let activeStepId = "";
      let persistenceError: unknown;
      // 仅在仓储写入成功后清空 buffer；落盘失败时保留缓冲并中断请求，不向 UI 发布假进度。
      const flush = () => {
        if (buffer) {
          if (!this.store.appendStepDelta(run.id, activeStepId, buffer))
            throw new AppError("interrupted", "运行已结束，不能继续追加内容。");
          buffer = "";
        }
      };
      // 合并小分片以控制 SQLite 写入频率；此节拍与 Server 轮询 SSE 的 250ms 相互独立。
      let lastElapsedSave = Date.now();
      const timer = setInterval(() => {
        try {
          flush();
          if (Date.now() - lastElapsedSave >= 1000) {
            const checkpoint = this.toolSystem?.options.store.get(
              "checkpoints",
              run.id,
            );
            if (checkpoint) {
              checkpoint.activeMilliseconds =
                initialElapsed + Date.now() - started;
              checkpoint.updatedAt = new Date().toISOString();
              this.toolSystem?.options.store.put("checkpoints", checkpoint);
            }
            lastElapsedSave = Date.now();
          }
        } catch (error) {
          persistenceError = error;
          controller.abort();
        }
      }, 250);
      try {
        // Run 只受用户/生命周期取消控制；各模型、工具、Hook 仍管理自己的单次超时。
        await this.plugins?.connectRun(run.id, controller.signal);
        await this.prepareExecution?.(run, controller.signal);
        await this.hooks?.trigger(
          run.id,
          "RunStart",
          "start",
          controller.signal,
        );
        const result = await runAgent({
          runId: run.id,
          ...(this.team
            ? {
                boundary: (
                  phase: "input" | "complete",
                  records: readonly ModelMessage[],
                  signal: AbortSignal,
                ) => this.team!.boundary(run.id, phase, records, signal),
                accountOutput: (count: number, kind: "model" | "tool") => {
                  if (kind === "tool") this.team!.account(run.id, count);
                },
              }
            : {}),
          model,
          ...(this.contexts
            ? {
                contextBuilder: this.contexts.forRun(
                  run,
                  model,
                  modelHistory.length ? modelHistory : undefined,
                ),
              }
            : {}),
          current,
          history: modelHistory,
          instructions: [
            instructions,
            run.executionMode === "full_access"
              ? "本轮由用户选择完全访问：本地工具无需命令或资源审批，进程不使用 MyAgent OS 沙箱，可访问当前系统用户可访问的文件和网络。不要把历史审批状态误认为本轮仍需批准；工具报错和未知结果仍须如实处理。"
              : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          ...(resume ? { resume } : {}),
          onCheckpoint: (checkpoint) => {
            const stored = this.toolSystem?.options.store.get(
              "checkpoints",
              run.id,
            );
            if (stored) {
              stored.runtime = JSON.parse(
                JSON.stringify(checkpoint),
              ) as JsonValue;
              stored.activeMilliseconds = initialElapsed + Date.now() - started;
              stored.updatedAt = new Date().toISOString();
              const commit = () =>
                this.toolSystem?.options.store.put("checkpoints", stored);
              if (this.team) this.team.checkpoint(run.id, checkpoint, commit);
              else commit();
            }
          },
          signal: controller.signal,
          tools: executionTools,
          limits,
          onEvent: (event) => {
            if (persistenceError) throw persistenceError;
            if (event.type === "step.preparing") {
              this.observations?.beginStep(
                event.runId,
                event.stepId,
                event.index,
              );
            } else if (event.type === "step.delta") {
              activeStepId = event.stepId;
              buffer += event.delta;
            } else if (event.type === "context.trimmed")
              this.store.markContextTrimmed(run.id);
            else {
              // 模型和工具边界是提交屏障；先落最后一批文字，再保存包含完整响应的步骤。
              flush();
              activeStepId = event.step.id;
              const step =
                this.closing &&
                (event.step.status === "cancelled" ||
                  event.step.status === "failed")
                  ? {
                      ...event.step,
                      status: "interrupted" as const,
                      tools: event.step.tools.map((t) =>
                        t.status === "cancelled"
                          ? { ...t, status: "interrupted" as const }
                          : t,
                      ),
                    }
                  : event.step;
              if (
                !this.store.saveStep({
                  step,
                  identity,
                  continuation: event.continuation ?? null,
                })
              )
                throw new AppError("interrupted", "运行已结束，不能继续执行。");
              this.observations?.step(step);
            }
          },
        });
        // 定时写入失败可能触发模型取消；优先传播落盘故障，不能将它误报为用户主动停止。
        if (persistenceError) throw persistenceError;
        flush();
        // 先持久化待收尾业务结果，再释放工具进程；恢复只继续收尾，不再次请求模型。
        const outcome = {
          status: "succeeded" as const,
          ...result,
          error: null,
        };
        if (!this.closing && !controller.signal.aborted)
          this.hooks?.stageEnd(run, outcome);
        // 先 flush 最后不足一个周期的文字，再提交成功终态；SSE 不会先看到成功、后看到尾字。
        if (this.toolSystem) {
          this.toolSystem.options.store.setRunStatus(run.id, "cleaning");
          if (!(await this.toolSystem.finish(run.id))) {
            this.toolSystem.options.store.setRunStatus(
              run.id,
              "waiting_reconciliation",
            );
            throw new AppError(
              "execution_paused",
              "部分进程未确认停止，需要核对。",
            );
          }
        }
        if (!this.closing && !controller.signal.aborted) {
          this.hooks?.stageEnd(run, outcome);
          await this.hooks?.end(run.id, controller.signal);
          if (this.toolSystem && !(await this.toolSystem.finish(run.id))) {
            this.toolSystem.options.store.setRunStatus(
              run.id,
              "waiting_reconciliation",
            );
            throw new AppError("execution_paused", "Hook 收尾进程需要核对。");
          }
        }
        controller.signal.throwIfAborted();
        this.finish(run.id, outcome);
      } catch (error) {
        if (error instanceof AppError && error.code === "execution_paused")
          return;
        if (
          error instanceof AppError &&
          error.code === "provider_context_limit" &&
          this.contexts
        ) {
          this.contexts.blocked(run.id, error);
          return;
        }
        try {
          if (!this.closing) await this.team?.stopChildren(run.id, false);
          flush();
          // 已知业务失败也先保存收尾意图；清理暂停后恢复不得重新调用失败的模型请求。
          if (
            !this.closing &&
            !controller.signal.aborted &&
            !persistenceError &&
            !(
              error instanceof AppError &&
              ["execution_storage", "cancelled", "interrupted"].includes(
                error.code,
              )
            )
          ) {
            const failure =
              error instanceof AppError
                ? { code: error.code, message: error.message }
                : {
                    code: "internal_error",
                    message: "本地处理失败，请检查执行记录。",
                  };
            this.hooks?.stageEnd(run, {
              status: "failed",
              finishReason: null,
              usage: null,
              error: failure,
            });
          }
          if (this.toolSystem) {
            this.toolSystem.options.store.setRunStatus(run.id, "cleaning");
            const confirmed = await this.toolSystem.finish(run.id);
            if (!confirmed) {
              this.toolSystem.options.store.setRunStatus(
                run.id,
                "waiting_reconciliation",
              );
              return;
            }
            if (this.closing) {
              this.toolSystem.options.store.setRunStatus(run.id, "recoverable");
              return;
            }
            if (
              persistenceError ||
              (error instanceof AppError && error.code === "execution_storage")
            ) {
              const uncertain = this.toolSystem.options.store
                .list("invocations", { runId: run.id })
                .some((item) => item.status === "unknown" && !item.resolution);
              this.toolSystem.options.store.setRunStatus(
                run.id,
                uncertain ? "waiting_reconciliation" : "recoverable",
              );
              return;
            }
          }
          // 服务关闭与用户停止分开标记；未知异常转换为本地安全提示，不持久化外部原始异常。
          const safe = this.closing
            ? new AppError(
                "interrupted",
                "本地服务已退出，生成中断，可手动重试。",
              )
            : controller.signal.aborted
              ? new AppError("cancelled", "生成已停止。")
              : error instanceof AppError
                ? error
                : new AppError(
                    "internal_error",
                    "本地处理失败，请检查数据目录或稍后重试。",
                    500,
                  );
          this.toolSystem?.cancelApprovals(run.id);
          if (
            !this.closing &&
            !controller.signal.aborted &&
            !["cancelled", "interrupted"].includes(safe.code)
          ) {
            this.hooks?.stageEnd(run, {
              status: "failed",
              finishReason: null,
              usage: null,
              error: { code: safe.code, message: safe.message },
            });
            await this.hooks?.end(run.id, controller.signal);
            if (this.toolSystem && !(await this.toolSystem.finish(run.id))) {
              this.toolSystem.options.store.setRunStatus(
                run.id,
                "waiting_reconciliation",
              );
              return;
            }
          }
          this.finish(run.id, {
            status:
              safe.code === "interrupted"
                ? "interrupted"
                : safe.code === "cancelled"
                  ? "cancelled"
                  : "failed",
            finishReason: null,
            usage: null,
            error: { code: safe.code, message: safe.message },
          });
        } catch {
          /* 磁盘不可写时不伪造完成；启动恢复会将 running 标为 interrupted。 */
        }
      } finally {
        this.observations?.endRun(run.id, this.store.getRun(run.id).status);
        clearInterval(timer);
        const checkpoint = this.toolSystem?.options.store.get(
          "checkpoints",
          run.id,
        );
        if (checkpoint && isActiveRun(this.store.getRun(run.id).status)) {
          checkpoint.activeMilliseconds = initialElapsed + Date.now() - started;
          checkpoint.updatedAt = new Date().toISOString();
          try {
            this.toolSystem?.options.store.put("checkpoints", checkpoint);
          } catch {
            /* 保留最后一次持久检查点，不伪造已保存进度。 */
          }
        }
        this.active.delete(run.id);
      }
    });
    this.active.set(run.id, { controller, done });
  }
  // 取消先传播信号，再等待缓冲与终态提交完毕；调用方得到可立即重新读取的一致状态。
  async cancel(runId: string): Promise<Run> {
    const run = this.store.getRun(runId);
    await this.team?.stopChildren(runId);
    const active = this.active.get(runId);
    if (active) {
      active.controller.abort();
      await active.done;
    } else if (isActiveRun(run.status)) {
      if (this.toolSystem && !(await this.toolSystem.finish(runId)))
        return this.store.getRun(runId);
      this.toolSystem?.cancelApprovals(runId);
      this.finish(runId, {
        status: "cancelled",
        finishReason: null,
        usage: null,
        error: { code: "cancelled", message: "运行已停止。" },
      });
    }
    return this.store.getRun(run.id);
  }
  // 先收拢执行，再级联删除会话；仓储还会拒绝迟到增量，防止外部不合作时恢复已删除数据。
  async deleteSession(id: string, internal = false): Promise<void> {
    if (this.team?.member(id) && !internal)
      throw new AppError("agent_internal", "请通过主对话关闭成员。", 403);
    await this.team?.beforeDelete(id);
    const run = this.store.snapshot(id).activeRun;
    if (run) await this.cancel(run.id);
    if (this.store.snapshot(id).activeRun)
      throw new AppError(
        "cleanup_unknown",
        "仍有未确认结束的执行，请先核对后再删除会话。",
        409,
      );
    for (const member of this.team?.store
      .list("members")
      .filter((m) => m.sessionId === id) ?? [])
      await this.deleteSession(member.internalSessionId, true);
    await this.memoryLifecycle?.deleteSession(id);
    if (this.toolSystem) {
      this.toolSystem.archiveConcerns(id);
      await this.toolSystem.options.gateway.deleteRecords?.(
        this.toolSystem.options.store.list("attempts", { sessionId: id }),
        this.toolSystem.options.store.list("processes", { sessionId: id }),
      );
      await this.toolSystem.options.results.deleteSession(id);
    }
    const files = this.observations
      ? this.observations.store.transaction(() => {
          const ids = this.observations!.anonymizeSession(id);
          this.store.deleteSession(id);
          return ids;
        })
      : (this.store.deleteSession(id), []);
    for (const file of files) await this.observations?.files.remove(file);
    this.skills?.collect();
    this.hooks?.collect();
  }
  async maintain(): Promise<void> {
    if (this.closing || !this.toolSystem) return;
    this.toolSystem.expireApprovals();
    for (const checkpoint of this.toolSystem.options.store.list(
      "checkpoints",
    )) {
      const run = this.store.getRun(checkpoint.runId);
      if (!isActiveRun(run.status) || this.active.has(run.id)) continue;
      const now = Date.now();
      const running = this.toolSystem.options.store
        .list("processes", { runId: run.id })
        .some((process) => process.status === "running");
      if (running)
        checkpoint.activeMilliseconds += Math.max(
          0,
          now - Date.parse(checkpoint.updatedAt),
        );
      checkpoint.updatedAt = new Date(now).toISOString();
      this.toolSystem.options.store.put("checkpoints", checkpoint);
    }
  }
  // 退出后拒绝新请求，并并行等待全部活动运行完成中断提交；不启动恢复或重试模型。
  async close(): Promise<void> {
    this.closing = true;
    this.team?.close();
    const runs = [...this.active.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.done));
  }
}
