/**
 * Chat Completions 适配器：聚合工具参数和文字分片，完整结束后才向内核交付工具调用。
 * 对话和工具结果由 MyAgent 管理；reasoning_content 仅作为私有续接材料保存与回传。
 */
import {
  AppError,
  type JsonValue,
  type ObservationScope,
  type ToolCall,
  type ToolDefinition,
  type Usage,
} from "@myagent/contracts";
import type { ModelEvent, ModelMessage, ModelPort } from "@myagent/kernel";
import { estimateTokens } from "@myagent/kernel";
import type { ModelTransportObserver } from "@myagent/observability";
import type OpenAI from "openai";
import { capturedFetch, reportedUsage } from "../../observability/transport.js";
import { client, modelError, stableTools } from "./shared.js";

export { modelError } from "./shared.js";
export class OpenAIChatModel implements ModelPort {
  private readonly client: OpenAI;
  private readonly deepseek: boolean;
  constructor(
    baseUrl: string,
    apiKey: string,
    private readonly model: string,
    private readonly telemetry?: ModelTransportObserver,
  ) {
    this.client = client(baseUrl, apiKey);
    this.deepseek = new URL(baseUrl).hostname === "api.deepseek.com";
  }
  /** 估算和发送共用请求构造，避免 Responses Item 与展示正文重复计数。 */
  private request(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
  ) {
    const input = messages.map((message) => {
      if (message.role === "tool")
        return {
          role: "tool",
          tool_call_id: message.callId,
          content: message.content,
        };
      const value: Record<string, unknown> = {
        role: message.role,
        content: message.content,
      };
      if (message.toolCalls?.length)
        value.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      if (message.role === "assistant") {
        const saved = message.continuation as
          | { protocol?: string; reasoningContent?: string }
          | undefined;
        if (
          saved?.protocol === "chat_completions" &&
          saved.reasoningContent !== undefined
        )
          value.reasoning_content = saved.reasoningContent;
        // 旧文字历史没有推理内容，空串只表示缺失，不能杜撰旧模型的推理。
        else if (this.deepseek && tools.length) value.reasoning_content = "";
      }
      return value;
    }) as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    return {
      model: this.model,
      messages: input,
      stream: true as const,
      stream_options: { include_usage: true },
      ...(tools.length
        ? {
            tools: stableTools(tools).map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
                strict: false,
              },
            })),
          }
        : {}),
    };
  }
  estimateInput(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[] = [],
  ): number {
    return estimateTokens(this.request(messages, tools));
  }
  async *stream(
    messages: readonly ModelMessage[],
    signal: AbortSignal,
    tools: readonly ToolDefinition[] = [],
    scope: ObservationScope = {},
  ): AsyncIterable<ModelEvent> {
    try {
      const transport =
        this.telemetry && scope.callId
          ? capturedFetch(
              this.telemetry,
              scope.callId,
              globalThis.fetch,
              signal,
            )
          : undefined;
      const sdk = transport
        ? this.client.withOptions({ fetch: transport })
        : this.client;
      const stream = await sdk.chat.completions.create(
        this.request(messages, tools),
        { signal },
      );
      let finishReason: string | null = null;
      let content = "";
      let reasoningContent = "";
      let hasReasoning = false;
      let usage: Usage | null = null;
      const calls = new Map<number, ToolCall>();
      try {
        for await (const chunk of stream) {
          // 元数据在协议校验前采集，失败响应也保留已上报的实际用量。
          if (scope.callId)
            this.telemetry?.metadata(scope.callId, {
              ...(chunk.usage
                ? { usage: reportedUsage(chunk.usage, "chat_completions") }
                : {}),
              model: chunk.model,
              responseId: chunk.id,
              ...(chunk.service_tier
                ? { serviceTier: chunk.service_tier }
                : {}),
            });
          const choice = chunk.choices[0];
          // 结束后只允许独立 usage 帧；禁止把结束后补来的参数拼成可执行调用。
          if (finishReason && choice)
            throw new AppError(
              "model_protocol",
              "模型在结束后继续发送响应。",
              502,
            );
          if (choice?.delta.content) {
            content += choice.delta.content;
            yield { type: "text", text: choice.delta.content };
          }
          const reasoning = (
            choice?.delta as { reasoning_content?: string } | undefined
          )?.reasoning_content;
          if (typeof reasoning === "string") {
            hasReasoning = true;
            reasoningContent += reasoning;
            yield { type: "output", characters: reasoning.length };
          }
          for (const delta of choice?.delta.tool_calls ?? []) {
            if (!Number.isSafeInteger(delta.index) || delta.index < 0)
              throw new AppError(
                "model_protocol",
                "模型工具分片缺少有效序号。",
                502,
              );
            if (delta.type && delta.type !== "function")
              throw new AppError(
                "model_protocol",
                "模型返回了不支持的工具类型。",
                502,
              );
            const call = calls.get(delta.index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (delta.id) {
              if (call.id && call.id !== delta.id)
                throw new AppError(
                  "model_protocol",
                  "模型工具标识发生变化。",
                  502,
                );
              call.id = delta.id;
            }
            if (delta.function?.name) call.name += delta.function.name;
            if (delta.function?.arguments) {
              call.arguments += delta.function.arguments;
              yield {
                type: "output",
                characters: delta.function.arguments.length,
              };
            }
            calls.set(delta.index, call);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage)
            usage = reportedUsage(chunk.usage, "chat_completions");
        }
      } finally {
        stream.controller.abort();
      }
      if (!finishReason)
        throw new AppError(
          "incomplete_stream",
          "模型连接中断，回答未完整结束。",
          502,
        );
      const continuation: JsonValue | undefined = hasReasoning
        ? { protocol: "chat_completions", reasoningContent }
        : undefined;
      transport?.complete();
      yield {
        type: "done",
        finishReason,
        usage,
        response: {
          content,
          toolCalls: [...calls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, call]) => call),
          ...(continuation !== undefined ? { continuation } : {}),
        },
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw modelError(error);
    }
  }
}
