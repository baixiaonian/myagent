import { AppError, LIMITS, type Usage } from "@myagent/contracts";
import type { ModelMessage } from "../context/index.js";
import type { ModelEvent, ModelPort } from "../model/index.js";
export interface RuntimeResult {
  finishReason: string;
  usage: Usage | null;
}
function nextOrAbort<T>(next: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    next
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}
/** v1 的零工具运行：一次模型调用，明确取消、超时及完整结束。 */
export async function runChat(
  model: ModelPort,
  messages: readonly ModelMessage[],
  signal: AbortSignal,
  onText: (text: string) => void,
  timeoutMs: number = LIMITS.timeoutMs,
): Promise<RuntimeResult> {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(new AppError("cancelled", "生成已停止。"));
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new AppError("timeout", "模型响应超时，请稍后重试。", 504),
      ),
    timeoutMs,
  );
  let iterator: AsyncIterator<ModelEvent> | undefined;
  let result: RuntimeResult | null = null;
  let length = 0;
  try {
    iterator = model
      .stream(messages, controller.signal)
      [Symbol.asyncIterator]();
    while (true) {
      controller.signal.throwIfAborted();
      const item = await nextOrAbort(iterator.next(), controller.signal);
      if (item.done) break;
      if (item.value.type === "text") {
        length += item.value.text.length;
        if (length > 200000)
          throw new AppError("output_limit", "回答过长，已停止生成。", 422);
        onText(item.value.text);
      } else {
        result = {
          finishReason: item.value.finishReason,
          usage: item.value.usage,
        };
      }
    }
    if (!result)
      throw new AppError(
        "incomplete_stream",
        "模型连接中断，回答未完整结束。",
        502,
      );
    if (!length)
      throw new AppError(
        "empty_response",
        "模型没有返回文字回答，请检查模型配置。",
        502,
      );
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.abort();
    // 不等待忽略取消的适配器，以免阻塞用户停止与服务关闭。
    void iterator?.return?.().catch(() => undefined);
  }
}
