/**
 * 上下文公开协议：容量是估算，摘要是有来源的派生视图，不代表执行授权。
 * SDK/Web 仅接收本文件的安全 DTO；私有续接和凭证不得放入这些字段。
 */
import type { ChatError, Usage } from "./index.js";
export const CONTEXT_DEFAULTS = {
  // 产品默认按 200k（十进制 token 数）预算；显式保存值和在途 Run 快照优先。
  contextWindowTokens: 200_000,
  outputReserveTokens: 4096,
} as const;
export interface ContextCapacity {
  contextWindowTokens: number;
  outputReserveTokens: number;
}
export interface ContextStats {
  estimatedTokens: number;
  inputBudget: number;
  triggerTokens: number;
  targetTokens: number;
  summaryTokens: number;
  estimated: true;
  breakdown: {
    instructions: number;
    tools: number;
    conversation: number;
    skills?: number;
    hooks?: number;
  };
}
export interface ContextSummary {
  id: string;
  text: string;
  sourceIds: string[];
  createdAt: string;
  previewBased: boolean;
}
export interface ContextView {
  /** 本轮冻结的完整窗口与输出预留；旧服务可缺省，UI 不得用当前模型设置冒充。 */
  capacity?: ContextCapacity;
  runId: string;
  version: number;
  status: "ready" | "compacting" | "warning" | "blocked" | "interrupted";
  stats: ContextStats | null;
  summaries: ContextSummary[];
  error: ChatError | null;
  compactionRequests: number;
  compactionUsage: Usage | null;
  totalUsage: Usage | null;
  skills?: import("./skills.js").SkillContextView;
  ruleSource: { path: string; hash: string; bytes: number } | null;
}
export interface HistoryQuery {
  query?: string;
  sourceId?: string;
  cursor?: string;
  limit?: number;
  includeSuperseded?: boolean;
}
export interface HistoryEntry {
  /** 整轮回答分支状态与单个工具执行成功/失败含义不同。 */
  answerStatus?: string | null;
  sourceId: string;
  runId: string;
  kind: "user" | "assistant" | "step" | "invocation" | "hook" | "context";
  status: string;
  text: string;
  resultRefs: string[];
  offset: number;
  truncated: boolean;
}
export interface HistoryPage {
  entries: HistoryEntry[];
  nextCursor: string | null;
}
export interface ContextResumeInput {
  requestId?: string;
  contextAction?: "retry" | "apply_capacity";
}
