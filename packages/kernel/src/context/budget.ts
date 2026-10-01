/**
 * 上下文纯计算：预算、UTF-8 估算和调用配对分块，不读取文件或调用模型。
 * 估算不能替代服务商 tokenizer；完整工具批次是最小可替换单位。
 */
import {
  AppError,
  CONTEXT_DEFAULTS,
  type ContextCapacity,
} from "@myagent/contracts";
import type { ModelMessage } from "./index.js";
export function estimateTokens(value: unknown): number {
  return Math.ceil(
    new TextEncoder().encode(
      typeof value === "string" ? value : JSON.stringify(value),
    ).length / 3,
  );
}
export function contextBudget(capacity: Partial<ContextCapacity>) {
  const c = { ...CONTEXT_DEFAULTS, ...capacity };
  if (
    !Number.isSafeInteger(c.contextWindowTokens) ||
    !Number.isSafeInteger(c.outputReserveTokens) ||
    c.outputReserveTokens < 1
  )
    throw new AppError(
      "invalid_capacity",
      "上下文窗口和输出预留必须为正整数。",
    );
  const input =
    c.contextWindowTokens -
    c.outputReserveTokens -
    Math.max(1024, Math.ceil(c.contextWindowTokens * 0.15));
  if (input < 1024)
    throw new AppError(
      "invalid_capacity",
      "扣除输出预留和安全余量后，输入预算至少需要 1024。",
    );
  return {
    input,
    trigger: Math.floor(input * 0.8),
    target: Math.floor(input * 0.6),
    summary: Math.min(2048, Math.floor(input * 0.15)),
    // 目标是写作偏好，不是流式取消阈值；为完整且略长的摘要预留弹性空间。
    summaryMax: Math.min(8192, Math.floor(input * 0.3)),
  };
}
export function messageBlocks(
  messages: readonly ModelMessage[],
): ModelMessage[][] {
  const blocks: ModelMessage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "tool")
      throw new AppError("context_history", "上下文出现未配对的工具结果。");
    const block = [m];
    const calls = m.toolCalls ?? [];
    const seen = new Set<string>();
    for (const call of calls) {
      const result = messages[++i];
      if (
        result?.role !== "tool" ||
        result.callId !== call.id ||
        seen.has(call.id)
      )
        throw new AppError("context_history", "上下文工具调用与结果不完整。");
      seen.add(call.id);
      block.push(result);
    }
    blocks.push(block);
  }
  return blocks;
}

/** UTF-16 分页/分块不能把代理对切成两个非法 Unicode 片段。 */
export function wholeCharacterEnd(text: string, end: number): number {
  const safe = Math.min(end, text.length);
  const code = text.charCodeAt(safe - 1);
  return safe < text.length && code >= 0xd800 && code <= 0xdbff
    ? safe - 1
    : safe;
}
