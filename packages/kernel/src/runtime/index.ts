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
  type ToolResult,
  type Usage,
} from "@myagent/contracts";
import {
  type ContextBuilder,
  defaultContextBuilder,
  type ModelMessage,
} from "../context/index.js";
import type { ModelEvent, ModelPort, ModelResponse } from "../model/index.js";
import type { ToolExecutor } from "../tools/index.js";
export interface RuntimeResult {
  finishReason: string;
  usage: Usage | null;
}
export type RuntimeEvent =
  | { type: "step.updated"; step: RunStep; continuation?: JsonValue }
  | { type: "step.delta"; stepId: string; delta: string }
  | { type: "context.trimmed" };
export interface AgentOptions {
  runId: string;
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
  const limits = { ...AGENT_LIMITS, ...options.limits };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new AppError("invalid_limits", "运行资源配置必须为正整数。");
  const external = new AbortController();
  const cancel = () =>
    external.abort(new AppError("cancelled", "生成已停止。"));
  if (options.signal.aborted) cancel();
  else options.signal.addEventListener("abort", cancel, { once: true });
  const run = deadline(
    external.signal,
    limits.runTimeoutMs,
    new AppError("run_timeout", "本次运行超过总时限，已停止。", 504),
  );
  const current = [...options.current];
  const builder = options.contextBuilder ?? defaultContextBuilder;
  let step: RunStep | undefined;
  let continuation: JsonValue | undefined;
  let output = 0;
  let knownUsage = true;
  // ID 在本轮完整执行链内保持唯一，避免后续上下文中的工具结果产生歧义。
  const callIds = new Set<string>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const account = (characters: number) => {
    output += characters;
    if (output > limits.outputCharacters)
      throw new AppError("output_limit", "本次执行输出超过容量，已停止。", 422);
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
  try {
    for (let index = 1; ; index++) {
      run.signal.throwIfAborted();
      const context = builder.build({
        instructions: options.instructions ?? "",
        history: options.history ?? [],
        current,
        tools: options.tools.definitions,
        limits,
      });
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
      run.signal.throwIfAborted();
      const request = deadline(
        run.signal,
        limits.modelTimeoutMs,
        new AppError("timeout", "模型响应超时，请稍后重试。", 504),
      );
      let iterator: AsyncIterator<ModelEvent> | undefined;
      const stepOutputStart = output;
      let terminal: Extract<ModelEvent, { type: "done" }> | undefined;
      try {
        iterator = options.model
          .stream(context.messages, request.signal, options.tools.definitions)
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
      run.signal.throwIfAborted();
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
      // 非增量输出提供方仍需按完整内容补计预算；协议不得悄悄替换已公开文字。
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
      if (!["stop", "tool_calls", "completed"].includes(terminal.finishReason))
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
        run.signal.throwIfAborted();
        return {
          finishReason: terminal.finishReason,
          usage: knownUsage ? usage : null,
        };
      }
      step.status = "tools";
      await emitStep();
      for (const call of step.tools) {
        run.signal.throwIfAborted();
        call.status = "running";
        await emitStep();
        run.signal.throwIfAborted();
        const execution = deadline(
          run.signal,
          limits.toolTimeoutMs,
          new AppError("tool_timeout", "工具执行超时。", 504),
        );
        const stepId = step.id;
        let result: ToolResult;
        try {
          const data = await abortable(
            Promise.resolve().then(() => {
              execution.signal.throwIfAborted();
              return options.tools.execute(
                call,
                { runId: options.runId, stepId },
                execution.signal,
              );
            }),
            execution.signal,
          );
          result = {
            callId: call.id,
            ok: true,
            data,
            error: null,
            modelContent: "",
            truncated: false,
          };
        } catch (error) {
          run.signal.throwIfAborted();
          result = {
            callId: call.id,
            ok: false,
            data: null,
            error: safeError(error),
            modelContent: "",
            truncated: false,
          };
        } finally {
          execution.close();
        }
        run.signal.throwIfAborted();
        const full = JSON.stringify(
          result.ok ? result.data : { error: result.error },
        );
        account(full.length);
        const marker = "\n[工具结果已截断，完整结果保存在本地执行记录中]";
        result.truncated = full.length > limits.toolResultCharacters;
        result.modelContent = result.truncated
          ? full.slice(
              0,
              Math.max(0, limits.toolResultCharacters - marker.length),
            ) + marker.slice(0, limits.toolResultCharacters)
          : full;
        call.result = result;
        call.status = result.ok ? "succeeded" : "failed";
        await emitStep();
        run.signal.throwIfAborted();
        current.push({
          role: "tool",
          callId: call.id,
          content: result.modelContent,
        });
      }
      step.status = "completed";
      step.endedAt = new Date().toISOString();
      await emitStep();
    }
  } catch (error) {
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
    run.close();
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
    limits: { modelTimeoutMs: timeoutMs, runTimeoutMs: timeoutMs + 100 },
    onEvent(event) {
      if (event.type === "step.delta") onText(event.delta);
    },
  });
}
