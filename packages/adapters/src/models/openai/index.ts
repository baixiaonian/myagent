import { AppError, type Usage } from "@myagent/contracts";
import type { ModelEvent, ModelMessage, ModelPort } from "@myagent/kernel";
import OpenAI from "openai";
export function modelError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return new AppError("timeout", "模型响应超时，请稍后重试。", 504);
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401 || error.status === 403)
      return new AppError(
        "model_auth",
        "模型密钥无效或没有访问权限，请检查设置。",
        502,
      );
    if (error.status === 404)
      return new AppError(
        "model_not_found",
        "模型或接口不存在，请检查接口地址和模型名称。",
        502,
      );
    if (error.status === 429)
      return new AppError(
        "model_rate_limit",
        "模型服务当前限流或额度不足，请稍后重试。",
        502,
      );
    if (error.status && error.status >= 400 && error.status < 500)
      return new AppError(
        "model_request",
        "模型服务不接受当前请求，请检查模型配置或缩短对话。",
        502,
      );
  }
  return new AppError(
    "model_connection",
    "无法连接模型服务或流式响应中断，请检查接口和网络。",
    502,
  );
}
export class OpenAIChatModel implements ModelPort {
  private readonly client: OpenAI;
  constructor(
    baseUrl: string,
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey,
      maxRetries: 0,
      logLevel: "off",
      timeout: 120000,
    });
  }
  async *stream(
    messages: readonly ModelMessage[],
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    try {
      const stream = await this.client.chat.completions.create(
        { model: this.model, messages: [...messages], stream: true },
        { signal },
      );
      let finishReason: string | null = null;
      let usage: Usage | null = null;
      try {
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (choice?.delta.content)
            yield { type: "text", text: choice.delta.content };
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage)
            usage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            };
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
      if (finishReason === "tool_calls" || finishReason === "function_call")
        throw new AppError(
          "unsupported_response",
          "该模型返回了工具调用；当前仅支持文字聊天。",
          502,
        );
      yield { type: "done", finishReason, usage };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw modelError(error);
    }
  }
}
