/**
 * Agent 跨边界协议：运行步骤、工具调用和计划的可见事实，供仓储、SDK 与 Web 共用。
 * 厂商续接材料不属于公开 Step；它们只存在于服务端记录，不能随快照或 SSE 暴露。
 */
import type { ChatError, Usage } from "./index.js";

export type ApiProtocol = "responses" | "chat_completions";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: { [key: string]: JsonValue };
}
export interface ToolCall {
  id: string;
  name: string;
  /** 保留模型原始 JSON 文本；执行器负责解析和最终 Schema 校验。 */
  arguments: string;
}
export interface ToolResult {
  callId: string;
  ok: boolean;
  data: JsonValue;
  error: ChatError | null;
  /** 回传模型的投影；截断明确标记，已保存结果仍可查阅，采集完整性由 ResultRef 单独说明。 */
  modelContent: string;
  truncated: boolean;
  resultRef?: string;
  outcome?: "succeeded" | "failed" | "cancelled" | "unknown" | "denied";
  effectsPossible?: boolean;
}
export interface ToolExecution extends ToolCall {
  status:
    | "pending"
    | "running"
    | "waiting_approval"
    | "queued"
    | "unknown"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  result: ToolResult | null;
}
export interface PlanItem {
  description: string;
  status: "pending" | "in_progress" | "completed";
}
export interface RunPlan {
  steps: PlanItem[];
  explanation?: string;
}
export interface RunStep {
  id: string;
  runId: string;
  index: number;
  status:
    | "model"
    | "tools"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  content: string;
  tools: ToolExecution[];
  finishReason: string | null;
  usage: Usage | null;
  error: ChatError | null;
  createdAt: string;
  endedAt: string | null;
}
/** 仅限制单次请求/动作与上下文；不限制任务累计产出、总时长或模型轮数。 */
export const AGENT_LIMITS = {
  modelTimeoutMs: 120000,
  toolTimeoutMs: 30000,
  /** 单个命令进程的默认超时，独立于整项任务时长。 */
  commandTimeoutMs: 600000,
  contextCharacters: 32000,
  historyTurns: 20,
  toolResultCharacters: 8000,
} as const;
export type AgentLimits = {
  -readonly [K in keyof typeof AGENT_LIMITS]: number;
};
