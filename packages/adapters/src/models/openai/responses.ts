/**
 * Responses 适配器：本地保存并重放输出 Item，完全不依赖服务器 conversation / previous_response_id。
 * 推理与文本、函数调用保持原始相对顺序；续接材料只给服务端，不当作展示文本。
 */
import {
  AppError,
  type JsonValue,
  type ToolCall,
  type ToolDefinition,
  type Usage,
} from "@myagent/contracts";
import type { ModelEvent, ModelMessage, ModelPort } from "@myagent/kernel";
import type OpenAI from "openai";
import { client, json, modelError } from "./shared.js";
export class OpenAIResponsesModel implements ModelPort {
  private readonly client: OpenAI;
  constructor(
    baseUrl: string,
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = client(baseUrl, apiKey);
  }
  async *stream(
    messages: readonly ModelMessage[],
    signal: AbortSignal,
    tools: readonly ToolDefinition[] = [],
  ): AsyncIterable<ModelEvent> {
    try {
      const input: unknown[] = [];
      for (const message of messages) {
        const saved = message.continuation as
          | { protocol?: string; items?: JsonValue[] }
          | undefined;
        if (
          message.role === "assistant" &&
          saved?.protocol === "responses" &&
          saved.items
        )
          input.push(...saved.items);
        else if (message.role === "tool")
          input.push({
            type: "function_call_output",
            call_id: message.callId,
            output: message.content,
          });
        else {
          if (message.content)
            input.push({ role: message.role, content: message.content });
          for (const call of message.toolCalls ?? [])
            input.push({
              type: "function_call",
              call_id: call.id,
              name: call.name,
              arguments: call.arguments,
            });
        }
      }
      const stream = await this.client.responses.create(
        {
          model: this.model,
          input: input as OpenAI.Responses.ResponseInput,
          stream: true,
          store: false,
          include: ["reasoning.encrypted_content"],
          ...(tools.length
            ? {
                tools: tools.map((t) => ({
                  type: "function" as const,
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                  strict: false,
                })),
              }
            : {}),
        },
        { signal },
      );
      let terminal: OpenAI.Responses.Response | undefined;
      let streamed = "";
      let streamedExtra = 0;
      // 按输出 Item 关联参数分片；最终响应仍是执行依据，并与已收到的分片核对。
      const argumentsByItem = new Map<string, string>();
      try {
        for await (const event of stream) {
          // completed 是最后的语义事件；迟到参数或第二个终态不能重新激活已完成响应。
          if (terminal)
            throw new AppError(
              "model_protocol",
              "Responses 在结束后继续发送响应。",
              502,
            );
          if (event.type === "response.output_text.delta") {
            streamed += event.delta;
            yield { type: "text", text: event.delta };
          } else if (event.type === "response.function_call_arguments.delta") {
            if (
              typeof event.item_id !== "string" ||
              !event.item_id ||
              typeof event.delta !== "string"
            )
              throw new AppError(
                "model_protocol",
                "Responses 工具参数分片缺少有效标识。",
                502,
              );
            argumentsByItem.set(
              event.item_id,
              (argumentsByItem.get(event.item_id) ?? "") + event.delta,
            );
            streamedExtra += event.delta.length;
            yield { type: "output", characters: event.delta.length };
          } else if (
            event.type === "response.reasoning_text.delta" ||
            event.type === "response.reasoning_summary_text.delta"
          ) {
            streamedExtra += event.delta.length;
            yield { type: "output", characters: event.delta.length };
          } else if (
            event.type === "response.completed" ||
            event.type === "response.incomplete" ||
            event.type === "response.failed"
          ) {
            terminal = event.response;
          } else if (event.type === "error")
            throw new AppError(
              "model_request",
              "Responses 请求失败，请检查接口与模型配置。",
              502,
            );
        }
      } finally {
        stream.controller.abort();
      }
      if (!terminal)
        throw new AppError(
          "incomplete_stream",
          "Responses 连接中断，缺少结束事件。",
          502,
        );
      if (terminal.status === "failed")
        throw new AppError(
          "model_request",
          "Responses 模型执行失败，请检查接口与模型配置。",
          502,
        );
      let content = "";
      const calls: ToolCall[] = [];
      for (const item of terminal.output) {
        if ("status" in item && item.status && item.status !== "completed")
          throw new AppError(
            "model_incomplete",
            "Responses 包含未完成的输出项，已停止。",
            502,
          );
        if (item.type === "message")
          for (const part of item.content) {
            if (part.type === "output_text") content += part.text;
          }
        else if (item.type === "function_call") {
          const partial = item.id ? argumentsByItem.get(item.id) : undefined;
          if (partial !== undefined && !item.arguments.startsWith(partial))
            throw new AppError(
              "model_protocol",
              "Responses 完整参数与分片不一致。",
              502,
            );
          if (item.id) argumentsByItem.delete(item.id);
          calls.push({
            id: item.call_id,
            name: item.name,
            arguments: item.arguments,
          });
        } else if (item.type !== "reasoning")
          throw new AppError(
            "unsupported_response",
            "模型返回了本轮未开放的工具或输出类型。",
            502,
          );
      }
      if (argumentsByItem.size)
        throw new AppError(
          "model_protocol",
          "Responses 参数分片没有对应的完整工具调用。",
          502,
        );
      if (!content.startsWith(streamed))
        throw new AppError(
          "model_protocol",
          "Responses 完整文字与分片不一致。",
          502,
        );
      if (content.length > streamed.length)
        yield { type: "text", text: content.slice(streamed.length) };
      // 加密续接可能只在终态出现，也计入容量；去掉已计过的文字和额外增量。
      const items = json(terminal.output);
      yield {
        type: "output",
        characters: Math.max(
          0,
          JSON.stringify(items).length - content.length - streamedExtra,
        ),
      };
      const usage: Usage | null = terminal.usage
        ? {
            inputTokens: terminal.usage.input_tokens,
            outputTokens: terminal.usage.output_tokens,
            totalTokens: terminal.usage.total_tokens,
          }
        : null;
      yield {
        type: "done",
        finishReason:
          terminal.status === "completed" ? "completed" : "incomplete",
        usage,
        response: {
          content,
          toolCalls: calls,
          continuation: { protocol: "responses", items },
        },
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw modelError(error);
    }
  }
}
