/**
 * 批次工具端口与兼容执行器：循环只等待一批配对结果，不实现具体工具或权限分支。
 * 旧测试和纯聊天可用最小 execute 端口，默认批次在这里串行执行；生产注入 ToolService。
 */
import {
  type AgentLimits,
  AppError,
  type ChatError,
  type ToolCall,
  type ToolExecution,
  type ToolResult,
} from "@myagent/contracts";
import type { ToolContext, ToolExecutor } from "./index.js";
import { createToolPreview } from "./preview.js";

export interface ToolBatchOptions extends ToolContext {
  calls: readonly ToolCall[];
  signal: AbortSignal;
  limits: AgentLimits;
  onUpdate: (
    index: number,
    status: ToolExecution["status"],
    result?: ToolResult,
  ) => Promise<void>;
}
export async function executeToolBatch(
  executor: ToolExecutor,
  options: ToolBatchOptions,
): Promise<ToolResult[]> {
  if (executor.executeBatch) return executor.executeBatch(options);
  const results: ToolResult[] = [];
  for (const [index, call] of options.calls.entries()) {
    options.signal.throwIfAborted();
    await options.onUpdate(index, "running");
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    const timer = setTimeout(
      () =>
        controller.abort(new AppError("tool_timeout", "工具执行超时。", 504)),
      options.limits.toolTimeoutMs,
    );
    let result: ToolResult;
    try {
      const data = await raceSignal(
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return executor.execute(call, options, controller.signal);
        }),
        controller.signal,
      );
      result = {
        callId: call.id,
        ok: true,
        data,
        error: null,
        modelContent: "",
        truncated: false,
      };
    } catch (error) {
      options.signal.throwIfAborted();
      const safe: ChatError =
        error instanceof AppError
          ? { code: error.code, message: error.message }
          : { code: "internal_error", message: "工具执行失败。" };
      result = {
        callId: call.id,
        ok: false,
        data: null,
        error: safe,
        modelContent: "",
        truncated: false,
      };
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      controller.abort();
    }
    const full = JSON.stringify(
      result.ok ? result.data : { error: result.error },
    );
    const preview = createToolPreview(
      full,
      options.limits.toolResultCharacters,
    );
    result.truncated = preview.truncated;
    result.modelContent = preview.content;
    options.signal.throwIfAborted();
    await options.onUpdate(index, result.ok ? "succeeded" : "failed", result);
    results.push(result);
  }
  return results;
}
/** 只使等待可取消；真实执行器仍须终止进程或记录远端结果未知。 */
export function raceSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new AppError("cancelled", "操作已停止。"));
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
