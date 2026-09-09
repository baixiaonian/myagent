/**
 * 零工具聊天执行器：消费一次 ModelPort 流，将文字交给回调，返回结束原因和可选用量。
 * 负责取消、超时、输出上限及结束完整性；不持久化、不自动重试，也不创建工具循环。
 */
import { AppError, LIMITS, type Usage } from "@myagent/contracts";
import type { ModelMessage } from "../context/index.js";
import type { ModelEvent, ModelPort } from "../model/index.js";
export interface RuntimeResult {
  finishReason: string;
  usage: Usage | null;
}
// 将等待下一条流事件与取消竞争：即使适配器忽略 signal，内核也能按时结束。
// 同时接住原 next Promise 的迟到完成 / 拒绝，避免取消后出现未处理异常。
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
  // 使用内核私有信号区分用户取消与超时，不改变调用方的 AbortController。
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
    // 每次执行只创建一个模型流；后面的循环消费流事件，并非再次调用模型的 Agent 循环。
    iterator = model
      .stream(messages, controller.signal)
      [Symbol.asyncIterator]();
    while (true) {
      controller.signal.throwIfAborted();
      const item = await nextOrAbort(iterator.next(), controller.signal);
      if (item.done) break;
      if (item.value.type === "text") {
        length += item.value.text.length;
        // 限制单次总输出，防止无限文字流占满内存和磁盘；超过上限的分片不再交给 onText。
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
    // 网络读完不等于模型成功结束；必须收到 done 事件且存在文字，才能返回成功结果。
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
    // 所有出口均清理超时和外部监听，并中断适配器资源；不等待可能永不完成的 iterator.return。
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.abort();
    // 不等待忽略取消的适配器，以免阻塞用户停止与服务关闭。
    void iterator?.return?.().catch(() => undefined);
  }
}
