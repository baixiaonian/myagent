/**
 * 模型端口契约：把厂商响应统一为文字增量与结束事件。
 * 适配器提供 AsyncIterable 并接受 AbortSignal；内核只依赖这个接口，无需了解厂商协议。
 */
import type { Usage } from "@myagent/contracts";
import type { ModelMessage } from "../context/index.js";
// text 可以多次产生；done 表示模型给出了结束原因。usage 缺失为 null，不能补成 0。
export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "done"; finishReason: string; usage: Usage | null };
export interface ModelPort {
  // 实现方应把信号传到实际网络请求，并在流退出时释放连接；不得在内部静默重发生成。
  stream(
    messages: readonly ModelMessage[],
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent>;
}
