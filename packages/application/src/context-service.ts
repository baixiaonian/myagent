/**
 * 上下文应用服务：在模型请求边界选择完整记录、生成摘要并原子发布检查点。
 * 原始历史永不被摘要覆盖；摘要请求无工具，失败不自动重试，迟到响应不能复活 Run。
 */
import { emptyMemoryProvider, type MemoryProvider } from "@myagent/content";
import {
  AppError,
  CONTEXT_DEFAULTS,
  type ContextResumeInput,
  type ContextView,
  isActiveRun,
  type JsonValue,
  type Run,
} from "@myagent/contracts";
import {
  abortable,
  type ContextBuilder,
  type ContextInput,
  contextBudget,
  createToolPreview,
  defaultContextBuilder,
  estimateTokens,
  type ModelMessage,
  type ModelPort,
  messageBlocks,
  type ResultStorePort,
} from "@myagent/kernel";
import type {
  ChatStore,
  ContextRunRecord,
  ContextStore,
  ContextSummaryRecord,
  ExecutionStore,
  ProjectRulesPort,
  StoredSettings,
} from "@myagent/state";
import { connectionIdentity, executionHistory } from "./context.js";
import { ExecutionContextJournal } from "./context-facts.js";
import {
  contextChanges,
  contextComponent,
  contextMessages,
} from "./context-observation.js";
import { ContextSummarizer } from "./context-summarizer.js";
import {
  addUsage,
  type Block,
  hash,
  SUMMARY_VERSION,
  summaryMessage,
  zero,
} from "./context-support.js";
import type { HookService } from "./hooks.js";
import type { SkillService } from "./skills.js";
export class ContextService {
  observer?: import("@myagent/observability").ObserverPort;
  historyAugment?: (
    runId: string,
    messages: readonly ModelMessage[],
  ) => ModelMessage[];
  private readonly summarizer: ContextSummarizer;
  constructor(
    readonly store: ContextStore,
    private readonly chat: ChatStore,
    private readonly execution: ExecutionStore,
    private readonly rules: ProjectRulesPort,
    private readonly effects: (id: string) => string,
    private readonly memory: MemoryProvider = emptyMemoryProvider,
    private readonly triggerRatio = 0.8,
    private readonly results?: ResultStorePort,
    private readonly skills?: SkillService,
    private readonly hooks?: HookService,
  ) {
    this.summarizer = new ContextSummarizer(store, (state, signal) =>
      this.assertCurrent(state, signal),
    );
  }

  /** 与创建 Run 的事务一起调用；规则内容被冻结，后续文件修改只影响下一个 Run。 */
  initialize(
    run: Run,
    settings: StoredSettings,
    legacyCharacterLimit: number | null = null,
    legacy = false,
    parentRunId?: string,
  ): void {
    if (this.store.get("runs", run.id)) return;
    const session = this.chat.snapshot(run.sessionId).session;
    const workspace = session.workspaceId
      ? this.execution.get("workspaces", session.workspaceId)
      : null;
    const parent = parentRunId ? this.store.get("runs", parentRunId) : null;
    const rules = parent
      ? parent.view.ruleSource
        ? { text: parent.rules, ...parent.view.ruleSource }
        : null
      : workspace && !legacy
        ? this.rules.read(workspace.path)
        : null;
    const capacity = {
      contextWindowTokens:
        settings.contextWindowTokens ?? CONTEXT_DEFAULTS.contextWindowTokens,
      outputReserveTokens:
        settings.outputReserveTokens ?? CONTEXT_DEFAULTS.outputReserveTokens,
    };
    contextBudget(capacity);
    this.store.put("runs", {
      id: run.id,
      runId: run.id,
      sessionId: run.sessionId,
      capacity,
      identity: connectionIdentity(settings),
      instructionsHash: hash([settings.systemPrompt, rules?.hash ?? null]),
      rules: rules?.text ?? "",
      memory: "",
      memoryLoaded: false,
      summaryIds: [],
      automaticDisabled: false,
      force: false,
      generation: 0,
      resumeRequests: {},
      summaryOutputCharacters: 0,
      legacyCharacterLimit,
      view: {
        runId: run.id,
        version: 0,
        status: "ready",
        stats: null,
        summaries: [],
        error: null,
        compactionRequests: 0,
        compactionUsage: zero(),
        totalUsage: null,
        ruleSource: rules
          ? { path: rules.path, hash: rules.hash, bytes: rules.bytes }
          : null,
      },
    });
  }
  view(sessionId: string): ContextView | null {
    const snapshot = this.chat.snapshot(sessionId);
    const latest = snapshot.latestRun;
    const original =
      latest?.kind === "regenerate" &&
      latest.originalAssistantId &&
      ["failed", "cancelled", "interrupted"].includes(latest.status)
        ? snapshot.messages.find((m) => m.id === latest.originalAssistantId)
            ?.runId
        : undefined;
    const id = snapshot.activeRun?.id ?? original ?? latest?.id;
    if (!id) return null;
    const state = this.store.get("runs", id);
    if (!state) return null;
    const view = structuredClone(state.view);
    // 读取当前 Run 检查点中的容量，不使用可能已被用户改过的全局设置。
    view.capacity = structuredClone(state.capacity);
    const run = this.chat.getRun(id);
    if (view.status === "compacting" && !isActiveRun(run.status)) {
      view.status = "interrupted";
      view.error = {
        code: "context_interrupted",
        message: "上下文整理未发布，原历史与有效摘要保留。",
      };
    }
    view.totalUsage = run.usage
      ? addUsage(run.usage, view.compactionUsage)
      : null;
    return view;
  }
  history(run: Run): ModelMessage[][] {
    const messages = this.chat.snapshot(run.sessionId).messages;
    const index = messages.findIndex((m) => m.id === run.userMessageId);
    return executionHistory(
      this.chat,
      index < 0 ? [] : messages.slice(0, index),
      this.state(run.id).identity,
      (id, messages) => {
        const augmented = this.hooks?.augment(id, messages) ?? [...messages];
        const shared = this.historyAugment?.(id, augmented) ?? augmented;
        const previous = this.store.get("runs", id);
        return previous
          ? new ExecutionContextJournal(this.store, previous).augment(shared)
          : shared;
      },
    );
  }
  /** 恢复操作记录请求标识；重复 HTTP 不能再提升 generation 或再次产生摘要费用。 */
  resume(
    runId: string,
    input: ContextResumeInput,
    settings: StoredSettings,
  ): boolean {
    if (!input.contextAction) return true;
    if (!input.requestId)
      throw new AppError("invalid_input", "上下文恢复需要请求标识。");
    const state = this.state(runId);
    const fingerprint = JSON.stringify(input.contextAction);
    const old = state.resumeRequests[input.requestId];
    if (old && old !== fingerprint)
      throw new AppError("idempotency_conflict", "恢复请求标识已被使用。", 409);
    if (old) return false;
    if (input.contextAction === "apply_capacity") {
      state.capacity = {
        contextWindowTokens:
          settings.contextWindowTokens ?? CONTEXT_DEFAULTS.contextWindowTokens,
        outputReserveTokens:
          settings.outputReserveTokens ?? CONTEXT_DEFAULTS.outputReserveTokens,
      };
      contextBudget(state.capacity);
    }
    state.resumeRequests[input.requestId] = fingerprint;
    state.generation++;
    state.automaticDisabled = false;
    state.force = true;
    state.view.error = null;
    state.view.status = "ready";
    this.store.put("runs", state);
    return true;
  }
  blocked(runId: string, error: AppError): void {
    const state = this.state(runId);
    this.observer?.event({ runId }, "context.blocked", { code: error.code });
    state.view.status = "blocked";
    state.view.error = { code: error.code, message: error.message };
    this.store.transaction(() => {
      this.store.put("runs", state);
      this.execution.setRunStatus(runId, "waiting_context");
    });
  }
  forRun(
    run: Run,
    model: ModelPort,
    history: ModelMessage[][] = this.history(run),
  ): ContextBuilder {
    // 历史只在创建此 Run 执行实例时读一次；检查点保存来源，后续步骤不重复保存整份历史。
    return {
      build: defaultContextBuilder.build,
      prepare: async (input, signal) => {
        this.summarizer.observer = this.observer;
        const span = this.observer?.span(
          { ...input.observation, runId: run.id, sessionId: run.sessionId },
          "context.prepare",
        );
        let outcome = "succeeded";
        try {
          return await this.prepare(
            run,
            model,
            {
              ...input,
              observation: {
                ...input.observation,
                runId: run.id,
                sessionId: run.sessionId,
                ...(span?.id ? { parentSpanId: span.id } : {}),
              },
              current: this.currentSources(run, input.current),
              history,
            },
            signal,
          );
        } catch (error) {
          outcome = signal.aborted ? "cancelled" : "failed";
          this.observer?.event(
            {
              ...input.observation,
              ...(span?.id ? { parentSpanId: span.id } : {}),
            },
            "context.failed",
            { code: error instanceof AppError ? error.code : "context_error" },
          );
          signal.throwIfAborted();
          if (error instanceof AppError && error.code === "context_limit") {
            this.blocked(run.id, error);
            throw new AppError("execution_paused", error.message);
          }
          throw error;
        } finally {
          span?.end(outcome);
        }
      },
    };
  }
  private currentSources(
    run: Run,
    messages: readonly ModelMessage[],
  ): ModelMessage[] {
    if (messages.every((m) => m.sourceId)) return [...messages];
    const steps = this.chat
      .getSteps(run.id)
      .filter((r) => r.step.status === "completed");
    let index = 0;
    let active: (typeof steps)[number] | undefined;
    return messages.map((message) => {
      if (message.role === "user")
        return { ...message, sourceId: message.sourceId ?? run.userMessageId };
      if (message.role === "assistant") {
        active = steps[index++];
        return {
          ...message,
          ...(active && !message.sourceId ? { sourceId: active.step.id } : {}),
        };
      }
      if (message.role === "tool" && active && !message.sourceId) {
        const result = active.step.tools.find(
          (t) => t.id === message.callId,
        )?.result;
        return {
          ...message,
          sourceId: `${active.step.id}/tool/${message.callId}`,
          resultInfo: {
            resultRef: result?.resultRef ?? null,
            outcome: result?.outcome ?? (result?.ok ? "succeeded" : "failed"),
            error: result?.error
              ? { code: result.error.code, message: result.error.message }
              : null,
          },
        };
      }
      return message;
    });
  }
  private state(id: string): ContextRunRecord {
    const state = this.store.get("runs", id);
    if (!state)
      throw new AppError("context_missing", "上下文检查点不存在。", 409);
    return state;
  }
  private assertCurrent(state: ContextRunRecord, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.state(state.id).generation !== state.generation)
      throw new AppError("interrupted", "上下文版本已改变。", 409);
    const run = this.chat.getRun(state.runId);
    if (!["running", "recoverable", "waiting_context"].includes(run.status))
      throw new AppError("interrupted", "运行状态已改变。", 409);
  }
  private blocks(
    messages: readonly ModelMessage[],
    segment: Block["segment"],
    prefix: string,
  ): Block[] {
    return messageBlocks(messages).map((items, i) => ({
      messages: structuredClone(items),
      segment,
      sources: [
        { id: items[0]?.sourceId ?? `${prefix}/${i}`, hash: hash(items) },
      ],
    }));
  }
  private reuse(blocks: Block[], state: ContextRunRecord): Block[] {
    const candidates = this.store
      .list("summaries", state.sessionId)
      .filter(
        (s) =>
          s.published &&
          // 新模板只影响新生成任务，旧版本已验证完整的摘要仍可恢复复用。
          [1, SUMMARY_VERSION].includes(s.templateVersion) &&
          s.identity === state.identity &&
          s.instructionsHash === state.instructionsHash &&
          (s.runId === state.runId ||
            this.chat.getRun(s.runId).status === "succeeded"),
      )
      .sort((a, b) => b.sources.length - a.sources.length);
    const output: Block[] = [];
    for (let i = 0; i < blocks.length; ) {
      const summary = candidates.find((s) =>
        s.sources.every(
          (ref, j) =>
            blocks[i + j]?.sources[0]?.id === ref.id &&
            blocks[i + j]?.sources[0]?.hash === ref.hash,
        ),
      );
      if (summary) {
        output.push(
          this.summaryBlock(summary, blocks[i]?.segment ?? "history"),
        );
        i += summary.sources.length;
      } else {
        const block = blocks[i++];
        if (block) output.push(block);
      }
    }
    return output;
  }
  private summaryBlock(
    summary: ContextSummaryRecord,
    segment: Block["segment"],
  ): Block {
    return {
      segment,
      sources: summary.sources,
      summaryId: summary.id,
      messages: [summaryMessage(summary.text, summary.sources)],
    };
  }
  /** 从持久结果重建首尾；无文件的旧记录/最小执行器使用本次准备开始前的原文。 */
  private async project(
    blocks: Block[],
    maximum: number,
    sessionId: string,
    signal: AbortSignal,
    originals: Map<ModelMessage, string>,
    limits: Record<string, number>,
  ): Promise<string[]> {
    const changed: string[] = [];
    for (const block of blocks) {
      for (const message of block.messages) {
        if (message.role !== "tool") continue;
        const original = originals.get(message) ?? message.content;
        // 一旦容量整理缩小了某个来源的预览，后续请求保持该上限，避免旧历史来回变化。
        const sourceId = message.sourceId ?? block.sources[0]?.id ?? "";
        const maximumForSource = Math.min(maximum, limits[sourceId] ?? maximum);
        const info = message.resultInfo;
        const ref =
          info &&
          typeof info === "object" &&
          !Array.isArray(info) &&
          typeof info.resultRef === "string"
            ? info.resultRef
            : undefined;
        // 有引用就使用受控原文，不靠正文里是否出现“截断”猜测格式或版本。
        if (!ref && original.length <= maximumForSource) continue;
        signal.throwIfAborted();
        const preview =
          ref && this.results
            ? await abortable(
                this.results.preview(ref, sessionId, maximumForSource),
                signal,
              )
            : createToolPreview(original, maximumForSource, {
                facts: message.resultInfo ?? null,
                reference: ref
                  ? `read_tool_result resultId=${ref}`
                  : `read_conversation_history sourceId=${message.sourceId ?? block.sources[0]?.id ?? ""}`,
              });
        signal.throwIfAborted();
        message.content = preview.content;
        if (maximumForSource < 8000) limits[sourceId] = maximumForSource;
        if (preview.truncated || message.content !== original)
          changed.push(message.sourceId ?? block.sources[0]?.id ?? "");
      }
    }
    return changed;
  }
  private async prepare(
    run: Run,
    model: ModelPort,
    input: ContextInput,
    signal: AbortSignal,
  ) {
    const state = this.state(run.id);
    const budget = contextBudget(state.capacity);
    budget.trigger = Math.floor(budget.input * this.triggerRatio);
    budget.target = Math.min(budget.target, Math.floor(budget.trigger * 0.75));
    const estimate = (messages: readonly ModelMessage[], tools = input.tools) =>
      model.estimateInput?.(messages, tools) ??
      estimateTokens({ messages, tools });
    this.assertCurrent(state, signal);
    if (!state.memoryLoaded) {
      const memoryBudget = Math.min(2500, Math.floor(budget.input / 10));
      const pieces = await abortable(
        this.memory.read(
          {
            sessionId: run.sessionId,
            workspaceId:
              this.chat.snapshot(run.sessionId).session.workspaceId ?? null,
            query: input.current[0]?.content ?? "",
            budget: memoryBudget,
          },
          signal,
        ),
        signal,
      );
      state.memoryPieces = [];
      for (const piece of pieces) {
        const text = `\n[记忆资料 ${piece.sourceId} / ${piece.version} / ${piece.scope}]\n${piece.text}`;
        if (estimateTokens(state.memory + text) <= memoryBudget) {
          state.memory += text;
          state.memoryPieces.push(piece);
        }
      }
      this.observer?.event(
        input.observation ?? { runId: run.id, sessionId: run.sessionId },
        "memory.snapshot",
        {
          count: state.memoryPieces.length,
          sources: state.memoryPieces
            .map((piece) => `${piece.sourceId}:${piece.version}`)
            .join(","),
        },
      );
      state.memoryLoaded = true;
      this.assertCurrent(state, signal);
      this.store.put("runs", state);
    }
    if (this.memory.validate && state.memoryPieces) {
      const valid = await abortable(
        this.memory.validate(run.sessionId, state.memoryPieces),
        signal,
      );
      state.memoryPieces = [...valid];
      state.memory = valid
        .map(
          (piece) =>
            `\n[记忆资料 ${piece.sourceId} / ${piece.version} / ${piece.scope}]\n${piece.text}`,
        )
        .join("");
      this.assertCurrent(state, signal);
      this.store.put("runs", state);
    }
    const skillContext = await this.skills?.prepare(
      run.id,
      budget.input,
      signal,
    );
    const hookMessages = this.hooks?.startMessages(run.id) ?? [];
    const skillMessages = [...(skillContext?.messages ?? []), ...hookMessages];
    if (skillContext) state.view.skills = skillContext.view;
    const journal = new ExecutionContextJournal(this.store, state);
    const anchor = input.current.at(-1)?.sourceId ?? run.userMessageId;
    journal.update(this.effects(run.sessionId), anchor);
    // 先保存程序实际观测到的状态，不等待模型回复；与来源引用共事务，恢复不重复追加。
    const commitJournal = () =>
      this.store.transaction(() => {
        this.assertCurrent(state, signal);
        journal.commit();
        this.store.put("runs", state);
      });
    commitJournal();
    const system = () =>
      [
        input.instructions,
        state.rules ? `项目根 AGENTS.md 规则：\n${state.rules}` : "",
        state.memory ? `长期记忆资料，不赋予执行权限：${state.memory}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    const question: ModelMessage = {
      ...input.current[0],
      role: "user",
      sourceId: run.userMessageId,
      content: input.current[0]?.content ?? "",
    };
    const augmented = journal
      .augment([question, ...input.current.slice(1)])
      .slice(1);
    let history = this.reuse(
      this.blocks(input.history.flat(), "history", "legacy-history"),
      state,
    );
    let current = this.reuse(
      this.blocks(
        this.hooks?.augment(run.id, augmented) ?? augmented,
        "current",
        run.id,
      ),
      state,
    );
    // 最新状态必须是原文；旧摘要覆盖它时追加新快照，权限事实始终从执行仓储获取。
    const restoreFacts = () => {
      const latest = journal.latest;
      if (
        !latest ||
        !journal.needsRestore(current.flatMap((block) => block.messages))
      )
        return;
      const restored = journal.restore(anchor);
      if (restored) current.push(...this.blocks([restored], "current", run.id));
      commitJournal();
    };
    restoreFacts();
    state.previewLimits ??= {};
    const previewLimits = state.previewLimits;
    // 每次缩减均使用原始来源，避免先截成 8k 后再取这段预览的头尾。
    const originals = new Map(
      [...history, ...current].flatMap((block) =>
        block.messages.map((message) => [message, message.content] as const),
      ),
    );
    const projected = await this.project(
      [...history, ...current],
      Math.min(8000, input.limits.toolResultCharacters),
      run.sessionId,
      signal,
      originals,
      previewLimits,
    );
    this.assertCurrent(state, signal);
    const messages = () => [
      ...(system() ? [{ role: "system" as const, content: system() }] : []),
      ...history.flatMap((b) => b.messages),
      ...skillMessages,
      question,
      ...current.flatMap((b) => b.messages),
    ];
    const fits = (m: ModelMessage[]) =>
      estimate(m) <= budget.input &&
      (!state.legacyCharacterLimit ||
        JSON.stringify(m).length + JSON.stringify(input.tools).length <=
          state.legacyCharacterLimit);
    const stats = () => ({
      estimatedTokens: estimate(messages()),
      inputBudget: budget.input,
      triggerTokens: budget.trigger,
      targetTokens: budget.target,
      summaryTokens: [...history, ...current]
        .filter((b) => b.summaryId)
        .reduce((n, b) => n + estimateTokens(b.messages), 0),
      estimated: true as const,
      breakdown: {
        instructions: estimateTokens(system()),
        tools: estimateTokens(input.tools),
        conversation: estimateTokens(
          [...history, ...current].flatMap((b) => b.messages).concat(question),
        ),
        skills: estimateTokens(skillContext?.messages ?? []),
        hooks: estimateTokens(hookMessages),
      },
    });
    const pause = (error: AppError): never => {
      state.view.stats = stats();
      this.observer?.event(
        input.observation ?? { runId: run.id },
        "context.blocked",
        {
          code: error.code,
        },
      );
      state.view.status = "blocked";
      state.view.error = { code: error.code, message: error.message };
      this.assertCurrent(state, signal);
      this.store.transaction(() => {
        this.store.put("runs", state);
        this.execution.setRunStatus(run.id, "waiting_context");
      });
      throw new AppError("execution_paused", error.message);
    };
    if (
      !fits([
        { role: "system", content: system() },
        ...skillMessages,
        question,
        ...(journal.requiredSnapshot ? [journal.requiredSnapshot] : []),
      ])
    )
      return pause(
        new AppError(
          "context_base_too_large",
          "系统指令、项目规则、技能说明、工具定义和当前问题已超过预算；请提高窗口或减少直接提供的工具。",
        ),
      );
    // 单个巨大结果先缩减预览；不会删除 callId、参数或续接 Item。
    if (!fits(messages()))
      projected.push(
        ...(await this.project(
          [...history, ...current],
          Math.min(512, input.limits.toolResultCharacters),
          run.sessionId,
          signal,
          originals,
          previewLimits,
        )),
      );
    this.assertCurrent(state, signal);
    if (
      (estimate(messages()) >= budget.trigger ||
        !fits(messages()) ||
        state.force) &&
      !state.automaticDisabled
    ) {
      const originalHistory = history,
        originalCurrent = current;
      try {
        for (const segment of ["history", "current"] as const) {
          const blocks = segment === "history" ? history : current;
          if (
            !blocks.length ||
            (fits(messages()) &&
              estimate(messages()) <= budget.target &&
              !state.force)
          )
            continue;
          // 最近三轮是选择偏好；当前预算不允许时，仍可覆盖最新完整批次。
          const projectedCandidate = (count: number): ModelMessage[] => {
            const replacement: ModelMessage[] = [
              summaryMessage(
                "摘".repeat(budget.summaryMax),
                blocks.slice(0, count).flatMap((b) => b.sources),
              ),
              ...blocks.slice(count).flatMap((b) => b.messages),
            ];
            return [
              ...(system()
                ? [{ role: "system" as const, content: system() }]
                : []),
              ...(segment === "history"
                ? replacement
                : history.flatMap((b) => b.messages)),
              ...skillMessages,
              question,
              ...(segment === "current"
                ? replacement
                : current.flatMap((b) => b.messages)),
              // 压缩若覆盖最新执行状态，还需为重新注入的原文留出空间。
              ...(segment === "current" &&
              journal.latest &&
              journal.needsRestore(
                blocks.slice(count).flatMap((b) => b.messages),
              )
                ? [journal.requiredSnapshot!]
                : []),
            ];
          };
          // 软阈值不等于必须压缩最新结果。尽量保留最近完整批次，让模型直接消费观察结果。
          // 只有保留它确实无法容纳时才允许摘要该批次；避免低阈值造成“查时间→摘要→再查”的循环。
          let maximum = blocks.length;
          // 状态日志是附加观察，不应把它误当成最近的业务批次而提前摘要刚返回的工具结果。
          const newestBatch = blocks.findLastIndex((block) =>
            block.messages.some(
              (message) => !message.sourceId?.startsWith("execution-context:"),
            ),
          );
          if (
            segment === "current" &&
            (fits(messages()) ||
              (newestBatch > 0 && fits(projectedCandidate(newestBatch))))
          )
            maximum = Math.max(0, newestBatch);
          if (!maximum) continue;
          const preferredHistory = Math.max(
            0,
            input.history.length - input.limits.historyTurns,
          );
          const preferredIds = new Set(
            input.history
              .slice(0, preferredHistory)
              .flatMap((r) => r.map((m) => m.sourceId)),
          );
          let count = 0;
          while (count < maximum) {
            count++;
            const candidate = projectedCandidate(count);
            if (
              fits(candidate) &&
              estimate(candidate) <= budget.target &&
              (segment === "current" ||
                !blocks[count]?.sources.some((s) => preferredIds.has(s.id)))
            )
              break;
          }
          const selected = blocks.slice(0, count);
          // 没有新增原文时不会对同一份摘要无限反复压缩。
          if (selected.every((b) => b.summaryId)) continue;
          const summary = await this.summarizer.summarize(
            state,
            model,
            selected,
            question,
            budget,
            input,
            signal,
          );
          const replacement = [
            this.summaryBlock(summary, segment),
            ...blocks.slice(count),
          ];
          if (segment === "history") history = replacement;
          else {
            current = replacement;
            restoreFacts();
          }
          state.force = false;
        }
        if (!fits(messages()))
          throw new AppError(
            "context_limit",
            "整理后仍超过上下文预算，请提高窗口或减少直接工具定义。",
          );
        state.view.status = "ready";
        state.view.error = null;
      } catch (error) {
        signal.throwIfAborted();
        // 存储失败不能作为可继续的摘要失败，否则会绕过持久屏障。
        if (
          !(error instanceof AppError) ||
          ["interrupted", "context_missing", "execution_storage"].includes(
            error.code,
          )
        )
          throw error;
        history = originalHistory;
        current = originalCurrent;
        state.automaticDisabled = true;
        state.force = false;
        state.view.error = { code: error.code, message: error.message };
        if (!fits(messages())) return pause(error);
        state.view.status = "warning";
      }
    }
    if (!fits(messages()))
      return pause(
        new AppError(
          "context_limit",
          "原上下文已无法容纳，请重试整理或调整容量。",
        ),
      );
    this.assertCurrent(state, signal);
    const active = [...history, ...current];
    state.summaryIds = active.flatMap((b) =>
      b.summaryId ? [b.summaryId] : [],
    );
    state.view.summaries = state.summaryIds.flatMap((id) => {
      const s = this.store.get("summaries", id);
      return s
        ? [
            {
              id: s.id,
              text: s.text,
              sourceIds: s.sources.map((r) => r.id),
              createdAt: s.createdAt,
              previewBased: s.previewBased,
            },
          ]
        : [];
    });
    state.view.stats = stats();
    state.view.version++;
    const artifact = {
      instructions: system(),
      tools: input.tools,
      memory: state.memory,
      skills: skillContext?.view ?? null,
    };
    const artifactId = `${run.sessionId}:${hash(artifact)}`;
    const components = [
      contextComponent(
        "instructions",
        "instructions",
        "基础与用户指令",
        input.instructions,
      ),
      ...(state.rules
        ? [contextComponent("rules", "rules", "项目根 AGENTS.md", state.rules)]
        : []),
      ...input.tools.map((tool) =>
        contextComponent(`tool:${tool.name}`, "tools", tool.name, tool),
      ),
      ...(state.memoryPieces ?? []).map((piece) =>
        contextComponent(
          `memory:${piece.sourceId}`,
          "memory",
          `${piece.sourceId} / ${piece.version}`,
          piece.text,
        ),
      ),
      ...contextMessages(skillMessages, "skills_hooks"),
      ...contextMessages(
        history.flatMap((b) => b.messages),
        "history",
      ),
      ...contextMessages(
        [question, ...current.flatMap((b) => b.messages)],
        "current",
      ),
    ];
    const previous = this.store.get(
      "manifests",
      `${run.id}:${state.view.version - 1}`,
    );
    const changes = contextChanges(
      components,
      state.view.version === 1 ? [] : previous?.components,
    );
    this.store.transaction(() => {
      this.assertCurrent(state, signal);
      for (const id of state.summaryIds) {
        const summary = this.store.get("summaries", id);
        if (summary && !summary.published)
          this.store.put("summaries", { ...summary, published: true });
      }
      this.store.put("artifacts", {
        id: artifactId,
        runId: run.id,
        sessionId: run.sessionId,
        value: JSON.parse(JSON.stringify(artifact)) as JsonValue,
      });
      this.store.put("manifests", {
        components,
        id: `${run.id}:${state.view.version}`,
        runId: run.id,
        sessionId: run.sessionId,
        version: state.view.version,
        sources: [
          ...history.flatMap((b) => b.sources),
          { id: run.userMessageId, hash: hash(question) },
          ...current.flatMap((b) => b.sources),
        ],
        messageHash: hash(messages()),
        summaryIds: state.summaryIds,
        toolSnapshotId: artifactId,
        projectedSources: projected,
        estimatedTokens: state.view.stats?.estimatedTokens ?? 0,
        createdAt: new Date().toISOString(),
      });
      this.store.put("runs", state);
    });
    this.observer?.event(
      input.observation ?? { runId: run.id, sessionId: run.sessionId },
      "context.prepared",
      {
        manifestId: `${run.id}:${state.view.version}`,
        version: state.view.version,
        estimatedTokens: state.view.stats?.estimatedTokens ?? 0,
        summaryCount: state.summaryIds.length,
        projectedSources: projected.length,
        inputBudget: budget.input,
        triggerTokens: budget.trigger,
        messageCount: messages().length,
        toolCount: input.tools.length,
        breakdown: JSON.stringify(state.view.stats?.breakdown ?? {}),
        baselineKnown: changes.baselineKnown,
        added: changes.added.length,
        changed: changes.changed.length,
        removed: changes.removed.length,
      },
    );
    // 有界事件元数据防止诊断反过来膨胀；完整来源仍在请求清单，正文只读原始材料。
    for (const [kind, items] of Object.entries({
      sources: components,
      added: changes.added,
      changed: changes.changed,
      removed: changes.removed,
    })) {
      if (!items.length && kind !== "sources") continue;
      this.observer?.event(
        input.observation ?? { runId: run.id },
        `context.${kind}`,
        {
          count: items.length,
          entries: JSON.stringify(items.slice(0, 200)),
          omitted: Math.max(0, items.length - 200),
        },
      );
    }
    return {
      messages: messages(),
      contextVersion: state.view.version,
      stats: state.view.stats ?? stats(),
      trimmed: state.summaryIds.length > 0 || projected.length > 0,
    };
  }
}
