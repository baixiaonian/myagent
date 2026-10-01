/**
 * 模型适配器公共边界：白名单错误映射和厂商客户端创建，供双协议适配器复用。
 * 从不把上游异常正文、响应头或密钥带入公开错误；不执行自动重试。
 */
import {
  AppError,
  type JsonValue,
  type ToolDefinition,
} from "@myagent/contracts";
import OpenAI from "openai";
/** 同一组工具使用确定的名称和对象键顺序，避免注册/发现顺序变化破坏缓存前缀。
 * 只规范 JSON 对象键，不重排数组、不修改 Schema 语义或私有续接 Item。
 */
export function stableTools(
  tools: readonly ToolDefinition[],
): ToolDefinition[] {
  const canonical = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key]!)]),
      );
    return value;
  };
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => ({
      ...tool,
      parameters: canonical(tool.parameters) as ToolDefinition["parameters"],
    }));
}
/** HTTP 错误和 Responses 流内错误使用同一白名单，不从不可信 message 猜测容量。 */
export function contextLimitError(code: unknown): AppError | null {
  return typeof code === "string" &&
    [
      "context_length_exceeded",
      "context_window_exceeded",
      "max_context_length_exceeded",
    ].includes(code)
    ? new AppError(
        "provider_context_limit",
        "服务商拒绝了上下文容量，请调整窗口设置并整理上下文后继续。",
        422,
      )
    : null;
}
// 只根据异常类型和状态码生成白名单提示；不回显厂商 message、响应体或鉴权请求头。
export function modelError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return new AppError("timeout", "模型响应超时，请稍后重试。", 504);
  if (error instanceof OpenAI.APIError) {
    const capacity = contextLimitError(error.code);
    if (capacity) return capacity;
    // DeepSeek 用 HTTP 402 表示余额不足；与参数错误、上下文容量和速率限制分别反馈。
    // 只按状态码返回固定文案，不将可能回显密钥的服务商错误正文送入公开 API。
    if (error.status === 402)
      return new AppError(
        "model_payment_required",
        "模型账户余额不足或计费受限，请到模型服务商检查余额与计费状态后重试。",
        502,
      );
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
        "模型服务不接受当前请求，请检查接口、协议与模型配置。",
        502,
      );
  }
  return new AppError(
    "model_connection",
    "无法连接模型服务或流式响应中断，请检查接口和网络。",
    502,
  );
}
export function client(baseUrl: string, apiKey: string): OpenAI {
  // 超时由统一运行器逐请求控制；SDK 不再设置一个更短、无法覆盖的额外期限。
  return new OpenAI({
    baseURL: baseUrl,
    apiKey,
    maxRetries: 0,
    logLevel: "off",
    timeout: 2147483647,
  });
}
export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
