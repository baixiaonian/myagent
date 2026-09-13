/**
 * 模型适配器公共边界：白名单错误映射和厂商客户端创建，供双协议适配器复用。
 * 从不把上游异常正文、响应头或密钥带入公开错误；不执行自动重试。
 */
import { AppError, type JsonValue } from "@myagent/contracts";
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
