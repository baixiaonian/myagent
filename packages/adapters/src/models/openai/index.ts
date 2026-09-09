/**
 * OpenAI 兼容模型适配器：把 Chat Completions 流转换为通用 ModelEvent。
 * 负责厂商参数、流结束判定和安全错误映射；关闭 SDK 自动重试与日志，避免重复费用和凭证泄露。
 */
import { AppError, type Usage } from "@myagent/contracts";
import type { ModelEvent, ModelMessage, ModelPort } from "@myagent/kernel";
import OpenAI from "openai";
// 只根据异常类型和状态码生成白名单提示；不回显厂商 message、响应体或鉴权请求头。
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
    // 关闭厂商 SDK 默认重试，确保一次 Run 不因网络问题自动产生第二次计费请求。
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey,
      maxRetries: 0,
      logLevel: "off",
      timeout: 120000,
    });
  }
  // 请求只发送 model、messages 和 stream，减少不同兼容服务对扩展参数支持差异的影响。
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
          // 按单答案消费 choices[0]；无 choices 的用量块仍可更新 usage，空 delta 不产生文字事件。
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
        // 即使消费者提前停止或流读取失败，也关闭 SDK 持有的网络流。
        stream.controller.abort();
      }
      // 只有传输 EOF 或 [DONE] 不足以确认完整模型回答，必须收到实际 finish_reason。
      if (!finishReason)
        throw new AppError(
          "incomplete_stream",
          "模型连接中断，回答未完整结束。",
          502,
        );
      // 当前产品没有工具执行器；将工具请求明确判为不支持，不能把它当文字成功交付。
      if (finishReason === "tool_calls" || finishReason === "function_call")
        throw new AppError(
          "unsupported_response",
          "该模型返回了工具调用；当前仅支持文字聊天。",
          502,
        );
      yield { type: "done", finishReason, usage };
    } catch (error) {
      // 保留内核给出的 cancelled / timeout 原因，避免把主动中止误映射成连接故障。
      if (signal.aborted) throw signal.reason;
      throw modelError(error);
    }
  }
}
