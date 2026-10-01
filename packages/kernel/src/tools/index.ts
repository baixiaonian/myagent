/**
 * 最小工具执行端口：Loop 只认识定义与调用，不认识时间、计划等具体业务。
 * 具体校验和执行位于注入的执行器；本端口不代表通用权限、审批或沙箱已经实现。
 */
import type {
  JsonValue,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@myagent/contracts";
import type { ToolBatchOptions } from "./batch.js";

export * from "./batch.js";
export * from "./execution.js";
export * from "./policy.js";
export * from "./preview.js";
export * from "./scheduler.js";
export interface ToolContext {
  runId: string;
  stepId: string;
}
export interface ToolExecutor {
  readonly definitions: readonly ToolDefinition[];
  /** 每次请求前获取不可变定义快照；MCP 检索结果从下一次模型请求生效。 */
  snapshot?(): Promise<readonly ToolDefinition[]>;
  executeBatch?(options: ToolBatchOptions): Promise<ToolResult[]>;
  execute(
    call: ToolCall,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<JsonValue>;
}

export * from "./commands.js";
