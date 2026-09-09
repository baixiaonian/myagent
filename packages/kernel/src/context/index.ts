/**
 * 纯上下文构建器：将持久历史、当前问题和系统提示组合成模型消息。
 * 仅选最近完整成功问答，按整轮和字符预算裁剪；不查询数据库、不检索、不自动摘要。
 */
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
  // 按用户问题寻找最后一条 completed 回答，排除失败、停止和已被替换的候选版本。
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
  // 系统提示和当前问题先占预算，再容纳历史；单位为字符，不将它伪称为精确 token。
  let remaining =
    LIMITS.contextCharacters - question.length - systemPrompt.length;
  const selected: ModelMessage[][] = [];
  // 从最近轮次向前选取，遇到预算不足即停止，保留连续的最近上下文。
  // 用 unshift 恢复时间顺序，整轮取舍避免留下没有答案的问题或没有问题的答案。
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
    // 只报告完整成功历史是否被预算裁剪；本来就不完整的历史不算预算截断。
    trimmed: selected.length < pairs.length,
  };
}
