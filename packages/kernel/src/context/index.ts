/**
 * 上下文端口与兼容构建器：Server 主路径注入异步 prepare；独立小型运行仍可使用同步 build。
 * 兼容构建器保留旧整轮字符裁剪；新主路径按完整调用批次生成有来源的上下文视图。
 */
import {
  AGENT_LIMITS,
  type AgentLimits,
  AppError,
  type ContextStats,
  type JsonValue,
  LIMITS,
  type Message,
  type ObservationScope,
  type ToolCall,
  type ToolDefinition,
} from "@myagent/contracts";
export interface ModelMessage {
  /** 来源仅供本地上下文管理，适配器不得序列化到厂商协议。 */
  sourceId?: string;
  resultInfo?: JsonValue;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  callId?: string;
  continuation?: JsonValue;
}
export interface ContextSnapshot {
  contextVersion?: number;
  stats?: ContextStats;
  messages: ModelMessage[];
  trimmed: boolean;
}
export interface ContextInput {
  /** 显式传递本次准备所属步骤；仅关联观测，不进入厂商消息或影响上下文选择。 */
  observation?: ObservationScope;
  instructions: string;
  history: readonly (readonly ModelMessage[])[];
  current: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  limits: AgentLimits;
}
export interface ContextBuilder {
  build(input: ContextInput): ContextSnapshot;
  prepare?(input: ContextInput, signal: AbortSignal): Promise<ContextSnapshot>;
}
// 用实际字符串长度加序列化附加字段估算容量；这不是 tokenizer。
function size(message: ModelMessage): number {
  const { content, role: _, ...extra } = message;
  return (
    content.length +
    (Object.keys(extra).length ? JSON.stringify(extra).length : 0)
  );
}
export const defaultContextBuilder: ContextBuilder = {
  build({ instructions, history, current, tools, limits }) {
    const prefix: ModelMessage[] = instructions
      ? [{ role: "system", content: instructions }]
      : [];
    let remaining =
      limits.contextCharacters -
      [...prefix, ...current].reduce((sum, m) => sum + size(m), 0) -
      (tools.length ? JSON.stringify(tools).length : 0);
    if (remaining < 0)
      throw new AppError(
        "context_limit",
        "本次执行所需上下文超过容量，请缩短任务或提高上下文容量。",
        422,
      );
    const selected: ModelMessage[][] = [];
    for (const round of history.toReversed()) {
      const length = round.reduce((sum, m) => sum + size(m), 0);
      if (selected.length >= limits.historyTurns || length > remaining) break;
      selected.unshift([...round]);
      remaining -= length;
    }
    return {
      messages: [...prefix, ...selected.flat(), ...current],
      trimmed: selected.length < history.length,
    };
  },
};
/** 老聊天历史转完整问答；只选择最终有效成功版本，候选失败不会污染后续模型。 */
export function chatHistory(history: readonly Message[]): ModelMessage[][] {
  return history
    .filter((m) => m.role === "user")
    .flatMap((question) => {
      const answer = history.findLast(
        (m) =>
          m.replyToId === question.id &&
          m.role === "assistant" &&
          m.status === "completed",
      );
      return answer
        ? [
            [
              { role: "user" as const, content: question.content },
              { role: "assistant" as const, content: answer.content },
            ],
          ]
        : [];
    });
}
export function buildContext(
  history: readonly Message[],
  question: string,
  systemPrompt: string,
): ContextSnapshot {
  if (!question.trim() || question.length > LIMITS.inputCharacters)
    throw new AppError("invalid_input", "请输入 1–8000 字符的问题。");
  return defaultContextBuilder.build({
    instructions: systemPrompt,
    history: chatHistory(history),
    current: [{ role: "user", content: question }],
    tools: [],
    limits: { ...AGENT_LIMITS },
  });
}

export * from "./budget.js";
