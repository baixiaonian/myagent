/**
 * 协议中立模型端口：流式文字与完整响应分开，工具只在完整响应后执行。
 * continuation 是适配器产生并读取的服务端续接数据，内核不解释其厂商字段。
 */
import type {
  JsonValue,
  ObservationScope,
  ToolCall,
  ToolDefinition,
  Usage,
} from "@myagent/contracts";
import type { ModelMessage } from "../context/index.js";
export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  continuation?: JsonValue;
}
export type ModelEvent =
  | { type: "text"; text: string }
  /** 非展示数据也计入资源预算，防止只有推理或工具参数的流无限增长。 */
  | { type: "output"; characters: number }
  | {
      type: "done";
      finishReason: string;
      usage: Usage | null;
      response?: ModelResponse;
    };
export interface ModelPort {
  /** 与实际请求共用序列化，结果只用于本地估算，不暴露私有输入。 */
  estimateInput?(
    messages: readonly ModelMessage[],
    tools?: readonly ToolDefinition[],
  ): number;
  stream(
    messages: readonly ModelMessage[],
    signal: AbortSignal,
    tools?: readonly ToolDefinition[],
    context?: ObservationScope,
  ): AsyncIterable<ModelEvent>;
}
