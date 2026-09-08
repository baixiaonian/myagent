import { AppError, LIMITS, type Message } from "@myagent/contracts";
export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface ContextSnapshot {
  messages: ModelMessage[];
  trimmed: boolean;
}
/** 只保留完整的成功问答对；字符预算不冒充模型 token 预算。 */
export function buildContext(
  history: readonly Message[],
  question: string,
  systemPrompt: string,
): ContextSnapshot {
  if (!question.trim() || question.length > LIMITS.inputCharacters)
    throw new AppError("invalid_input", "请输入 1–8000 字符的问题。");
  const pairs: ModelMessage[][] = [];
  for (const message of history) {
    if (message.role !== "user") continue;
    const answer = history.findLast(
      (item) =>
        item.replyToId === message.id &&
        item.role === "assistant" &&
        item.status === "completed",
    );
    if (answer)
      pairs.push([
        { role: "user", content: message.content },
        { role: "assistant", content: answer.content },
      ]);
  }
  let remaining =
    LIMITS.contextCharacters - question.length - systemPrompt.length;
  const selected: ModelMessage[][] = [];
  for (const pair of pairs.toReversed()) {
    const size = pair.reduce((sum, item) => sum + item.content.length, 0);
    if (selected.length >= LIMITS.contextTurns || size > remaining) break;
    selected.unshift(pair);
    remaining -= size;
  }
  return {
    messages: [
      ...(systemPrompt
        ? [{ role: "system" as const, content: systemPrompt }]
        : []),
      ...selected.flat(),
      { role: "user", content: question },
    ],
    trimmed: selected.length < pairs.length,
  };
}
