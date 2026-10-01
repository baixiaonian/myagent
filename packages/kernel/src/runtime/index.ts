/**
 * 自主 Agent 唯一循环：准备上下文、调用模型、执行工具、反馈结果，直到模型结束。
 * 不调度计划、不强制反思、不限制固定轮数。关键回调可等待，应用必须先持久化再允许继续。
 */
import {
  AGENT_LIMITS,
  type AgentLimits,
  AppError,
  type ChatError,
  type JsonValue,
  type RunStep,
  type Usage,
} from "@myagent/contracts";
import {
  type ContextBuilder,
  defaultContextBuilder,
  type ModelMessage,
} from "../context/index.js";
import type { ModelEvent, ModelPort, ModelResponse } from "../model/index.js";
import { executeToolBatch, type ToolExecutor } from "../tools/index.js";
export interface RuntimeResult {
  finishReason: string;
  usage: Usage | null;
}
export type RuntimeEvent =
  | { type: "step.preparing"; runId: string; stepId: string; index: number }
  | { type: "step.updated"; step: RunStep; continuation?: JsonValue }
  | { type: "step.delta"; stepId: string; delta: string }
  | { type: "context.trimmed" };
/** 服务端检查点：只在完整响应与工具提交边界保存；不能作为公开 SSE 数据。 */
export interface AgentCheckpoint {
  nextIndex: number;
  completionPending?: boolean;
  current: ModelMessage[];
  pendingStep: RunStep | null;
  continuation: JsonValue | null;
  /** 累计产出仅用于持久记录；旧检查点超过历史配额仍能继续。 */
  output: number;
  knownUsage: boolean;
  usage: Usage;
  callIds: string[];
}
export interface AgentOptions {
  runId: string;
  /** 应用在完整批次边界交付新输入；暂停由既有 execution_paused 表达。 */
  boundary?: (
    phase: "input" | "complete",
    current: readonly ModelMessage[],
    signal: AbortSignal,
  ) => Promise<ModelMessage[]>;
  accountOutput?: (characters: number, kind: "model" | "tool") => void;
  resume?: AgentCheckpoint;
  onCheckpoint?: (checkpoint: AgentCheckpoint) => Promise<void> | void;
  model: ModelPort;
  current: readonly ModelMessage[];
  history?: readonly (readonly ModelMessage[])[];
  instructions?: string;
  tools: ToolExecutor;
  signal: AbortSignal;
  onEvent: (event: RuntimeEvent) => Promise<void> | void;
  contextBuilder?: ContextBuilder;
  limits?: Partial<AgentLimits>;
}
/** 与信号竞争；接住迟到 resolve/reject，但不等待不合作的提供方。 */
export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}
function deadline(parent: AbortSignal, ms: number, error: AppError) {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  if (parent.aborted) cancel();
  else parent.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(error), ms);
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      parent.removeEventListener("abort", cancel);
      controller.abort();
    },
  };
}
function safeError(error: unknown): ChatError {
  return error instanceof AppError
    ? { code: error.code, message: error.message }
    : { code: "internal_error", message: "执行失败，请重试。" };
}
export async function runAgent(options: AgentOptions): Promise<RuntimeResult> {
  // 只取当前有效配置键；旧检查点的 runTimeoutMs/outputCharacters 不再参与控制。
  const limits = Object.fromEntries(
    Object.entries(AGENT_LIMITS).map(([key, value]) => [
      key,
      options.limits?.[key as keyof AgentLimits] ?? value,
    ]),
  ) as AgentLimits;
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new AppError("invalid_limits", "运行资源配置必须为正整数。");
  const external = new AbortController();
  const cancel = () =>
    external.abort(new AppError("cancelled", "生成已停止。"));
  if (options.signal.aborted) cancel();
  else options.signal.addEventListener("abort", cancel, { once: true });
  const current = structuredClone(
    options.resume?.current ?? [...options.current],
  );
  const builder = options.contextBuilder ?? defaultContextBuilder;
  let step: RunStep | undefined = options.resume?.pendingStep ?? undefined;
  let continuation: JsonValue | undefined =
    options.resume?.continuation ?? undefined;
  let completionPending = options.resume?.completionPending ?? false;
  let output = options.resume?.output ?? 0;
  let knownUsage = options.resume?.knownUsage ?? true;
  // ID 在本轮完整执行链内保持唯一，避免后续上下文中的工具结果产生歧义。
  const callIds = new Set<string>(options.resume?.callIds ?? []);
  const usage: Usage = {
    ...(options.resume?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
  };
  const account = (characters: number, kind: "model" | "tool" = "model") => {
    options.accountOutput?.(characters, kind);
    output += characters;
  };
  // 回调传快照，避免应用缓冲引用随后被内核原地修改；不把私有材料混入公开 Step。
  const emitStep = async () => {
    if (step)
      await options.onEvent({
        type: "step.updated",
        step: structuredClone(step),
        ...(continuation !== undefined ? { continuation } : {}),
      });
  };
  const checkpoint = async (nextIndex: number, pendingStep: RunStep | null) => {
    await options.onCheckpoint?.(
      structuredClone({
        nextIndex,
        completionPending,
        current,
        pendingStep,
        continuation: continuation ?? null,
        output,
        knownUsage,
        usage,
        callIds: [...callIds],
      }),
    );
  };
  try {
    for (let index = options.resume?.nextIndex ?? 1; ; index++) {
      external.signal.throwIfAborted();
      if (completionPending) {
        const added =
          (await options.boundary?.("complete", current, external.signal)) ??
          [];
        if (!added.length) {
          completionPending = false;
          await checkpoint(index, null);
          return { finishReason: "stop", usage: knownUsage ? usage : null };
        }
        current.push(...added);
        completionPending = false;
        step = undefined;
        await checkpoint(index, null);
      }
      account(0);
      // 准备也属于本轮步骤；尚未产生模型决策时，只开启中立生命周期关联。
      if (!step || step.status === "completed")
        await options.onEvent({
          type: "step.preparing",
          runId: options.runId,
          stepId: `${options.runId}:${index}`,
          index,
        });
      // 工具目录只在模型请求边界更新；已形成的调用批次保留其原始定义版本。
      const definitions = options.tools.snapshot
        ? await options.tools.snapshot()
        : options.tools.definitions;
      if (!step || step.status === "completed") {
        const incoming =
          (await options.boundary?.("input", current, external.signal)) ?? [];
        current.push(...incoming);
        await checkpoint(index, null);
        const contextInput = {
          observation: {
            runId: options.runId,
            stepId: `${options.runId}:${index}`,
          },
          instructions: options.instructions ?? "",
          history: options.history ?? [],
          current,
          tools: definitions,
          limits,
        };
        const context = builder.prepare
          ? await abortable(
              builder.prepare(contextInput, external.signal),
              external.signal,
            )
          : builder.build(contextInput);
        if (context.trimmed) await options.onEvent({ type: "context.trimmed" });
        step = {
          id: `${options.runId}:${index}`,
          runId: options.runId,
          index,
          status: "model",
          content: "",
          tools: [],
          finishReason: null,
          usage: null,
          error: null,
          createdAt: new Date().toISOString(),
          endedAt: null,
        };
        continuation = undefined;
        await emitStep();
        external.signal.throwIfAborted();
        const request = deadline(
          external.signal,
          limits.modelTimeoutMs,
          new AppError("timeout", "模型响应超时，请稍后重试。", 504),
        );
        let iterator: AsyncIterator<ModelEvent> | undefined;
        const stepOutputStart = output;
        let terminal: Extract<ModelEvent, { type: "done" }> | undefined;
        try {
          iterator = options.model
            .stream(context.messages, request.signal, definitions, {
              runId: options.runId,
              stepId: step.id,
              purpose: "agent",
            })
            [Symbol.asyncIterator]();
          while (true) {
            request.signal.throwIfAborted();
            const part = await abortable(iterator.next(), request.signal);
            if (part.done) break;
            if (terminal)
              throw new AppError(
                "model_protocol",
                "模型在结束事件后继续输出。",
                502,
              );
            if (part.value.type === "text") {
              account(part.value.text.length);
              step.content += part.value.text;
              await options.onEvent({
                type: "step.delta",
                stepId: step.id,
                delta: part.value.text,
              });
            } else if (part.value.type === "output")
              account(part.value.characters);
            else terminal = part.value;
          }
        } finally {
          request.close();
          void iterator?.return?.().catch(() => undefined);
        }
        external.signal.throwIfAborted();
        if (!terminal)
          throw new AppError(
            "incomplete_stream",
            "模型连接中断，回答未完整结束。",
            502,
          );
        const response: ModelResponse = terminal.response ?? {
          content: step.content,
          toolCalls: [],
        };
        // 非增量输出提供方仍需按完整内容补齐产出统计；协议不得悄悄替换已公开文字。
        if (!response.content.startsWith(step.content))
          throw new AppError(
            "model_protocol",
            "模型完整响应与文字流不一致。",
            502,
          );
        const responseSize =
          response.content.length +
          JSON.stringify(response.toolCalls).length +
          (response.continuation === undefined
            ? 0
            : JSON.stringify(response.continuation).length);
        account(Math.max(0, responseSize - (output - stepOutputStart)));
        step.content = response.content;
        continuation = response.continuation;
        step.finishReason = terminal.finishReason;
        step.usage = terminal.usage;
        if (terminal.usage)
          for (const key of [
            "inputTokens",
            "outputTokens",
            "totalTokens",
          ] as const)
            usage[key] += terminal.usage[key];
        else knownUsage = false;
        step.tools = response.toolCalls.map((call) => ({
          ...call,
          status: "pending",
          result: null,
        }));
        // 先核验整批调用再执行任何一项；重复/缺失 ID 会破坏模型结果配对。
        for (const call of step.tools) {
          if (
            typeof call.id !== "string" ||
            !call.id ||
            typeof call.name !== "string" ||
            !call.name ||
            typeof call.arguments !== "string" ||
            callIds.has(call.id)
          )
            throw new AppError(
              "model_protocol",
              "模型工具调用缺少标识或包含重复标识。",
              502,
            );
          callIds.add(call.id);
        }
        if (
          !["stop", "tool_calls", "completed"].includes(terminal.finishReason)
        )
          throw new AppError(
            "model_incomplete",
            "模型响应被截断或未正常完成，已停止。",
            502,
          );
        if (!step.tools.length && terminal.finishReason === "tool_calls")
          throw new AppError(
            "model_protocol",
            "模型声明工具调用但没有提供完整调用。",
            502,
          );
        current.push({
          role: "assistant",
          sourceId: step.id,
          content: response.content,
          ...(step.tools.length ? { toolCalls: response.toolCalls } : {}),
          ...(continuation !== undefined ? { continuation } : {}),
        });
        if (!step.tools.length) {
          if (!step.content)
            throw new AppError(
              "empty_response",
              "模型没有返回文字回答，请检查模型配置。",
              502,
            );
          step.status = "completed";
          step.endedAt = new Date().toISOString();
          await emitStep();
          external.signal.throwIfAborted();
          completionPending = true;
          await checkpoint(index + 1, null);
          const incoming =
            (await options.boundary?.("complete", current, external.signal)) ??
            [];
          if (incoming.length) {
            current.push(...incoming);
            completionPending = false;
            await checkpoint(index + 1, null);
            continue;
          }
          completionPending = false;
          await checkpoint(index + 1, null);
          return {
            finishReason: terminal.finishReason,
            usage: knownUsage ? usage : null,
          };
        }
        step.status = "tools";
        await emitStep();
        await checkpoint(index, step);
      }
      // 批次调度由端口实现；Loop 不认识工具名称、锁、审批或进程。
      const activeStep = step;
      if (!activeStep)
        throw new AppError("checkpoint_invalid", "缺少执行步骤。");
      const results = await executeToolBatch(options.tools, {
        runId: options.runId,
        stepId: activeStep.id,
        calls: activeStep.tools,
        signal: external.signal,
        limits,
        onUpdate: async (position, status, result) => {
          external.signal.throwIfAborted();
          const call = activeStep.tools[position];
          if (!call) throw new AppError("tool_protocol", "工具结果位置无效。");
          call.status = status;
          if (result) call.result = result;
          await emitStep();
          await checkpoint(index, activeStep);
        },
      });
      if (
        results.length !== activeStep.tools.length ||
        results.some((result, i) => result.callId !== activeStep.tools[i]?.id)
      )
        throw new AppError("tool_protocol", "工具结果未按原调用配对。");
      for (const result of results) {
        account(result.modelContent.length, "tool");
        current.push({
          role: "tool",
          sourceId: `${activeStep.id}/tool/${result.callId}`,
          callId: result.callId,
          content: result.modelContent,
          resultInfo: {
            resultRef: result.resultRef ?? null,
            outcome: result.outcome ?? (result.ok ? "succeeded" : "failed"),
            error: result.error
              ? { code: result.error.code, message: result.error.message }
              : null,
          },
        });
      }
      step.status = "completed";
      step.endedAt = new Date().toISOString();
      await emitStep();
      await checkpoint(index + 1, null);
    }
  } catch (error) {
    // 暂停保留完整模型响应和已经提交的工具事实，恢复时不能重新请求这一模型步骤。
    if (error instanceof AppError && error.code === "execution_paused")
      throw error;
    if (step && step.status !== "completed") {
      const safe = safeError(error);
      step.status = safe.code === "cancelled" ? "cancelled" : "failed";
      step.error = safe;
      step.endedAt = new Date().toISOString();
      for (const call of step.tools)
        if (call.status === "pending" || call.status === "running")
          call.status = step.status === "cancelled" ? "cancelled" : "failed";
      await emitStep();
    }
    throw error;
  } finally {
    external.abort();
    options.signal.removeEventListener("abort", cancel);
  }
}
/** 连接测试与旧调用方的无工具包装；底层仍然只有同一个 runAgent。 */
export async function runChat(
  model: ModelPort,
  messages: readonly ModelMessage[],
  signal: AbortSignal,
  onText: (text: string) => void,
  timeoutMs: number = AGENT_LIMITS.modelTimeoutMs,
): Promise<RuntimeResult> {
  return runAgent({
    runId: "chat",
    model,
    current: messages,
    tools: { definitions: [], execute: async () => null },
    signal,
    limits: { modelTimeoutMs: timeoutMs },
    onEvent(event) {
      if (event.type === "step.delta") onText(event.delta);
    },
  });
}
