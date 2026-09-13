/**
 * 最小工具执行端口：Loop 只认识定义与调用，不认识时间、计划等具体业务。
 * 具体校验和执行位于注入的执行器；本端口不代表通用权限、审批或沙箱已经实现。
 */
import type { JsonValue, ToolCall, ToolDefinition } from "@myagent/contracts";
export interface ToolContext {
  runId: string;
  stepId: string;
}
export interface ToolExecutor {
  readonly definitions: readonly ToolDefinition[];
  execute(
    call: ToolCall,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<JsonValue>;
}
