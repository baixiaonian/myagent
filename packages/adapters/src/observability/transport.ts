/** SDK HTTP 边界采集：每个 fetch 闭包绑定独立调用 ID，不复制认证头，不改变正文和 SSE 顺序。 */
import type { Usage } from "@myagent/contracts";
import type { ModelTransportObserver } from "@myagent/observability";
export function capturedFetch(
  observer: ModelTransportObserver,
  callId: string,
  base: typeof fetch = globalThis.fetch,
  sourceSignal?: AbortSignal,
): typeof fetch & { complete(): void } {
  // 正常模型结束后释放请求级取消监听：Loop 的 finally 清理不能冒充用户取消。
  // 已完成的业务输出立即交还；HTTP 尾部仍由独立的 150ms 上限收拢。
  let release = () => {};
  const request: typeof fetch = async (url, init) => {
    const input = observer.capture(callId, "input");
    if (typeof init?.body === "string")
      input?.write(new TextEncoder().encode(init.body));
    void input?.finish(
      typeof init?.body === "string" ? undefined : "unsupported_request_body",
    );
    observer.sent(callId);
    const output = observer.capture(callId, "output");
    const controller = output && sourceSignal ? new AbortController() : null;
    const abort = () => controller?.abort(sourceSignal?.reason);
    if (controller) {
      if (sourceSignal!.aborted) abort();
      else sourceSignal!.addEventListener("abort", abort, { once: true });
      release = () => sourceSignal!.removeEventListener("abort", abort);
    }
    let response: Response;
    try {
      // 采集开启时区分用户取消与 SDK 在 [DONE] 后的内部关闭；用户/超时信号仍直接控制真实连接。
      response = await base(
        url,
        controller ? { ...init, signal: controller.signal } : init,
      );
    } catch (error) {
      release();
      void output?.finish(
        init?.signal?.aborted ? "cancelled" : "network_error",
      );
      throw error;
    }
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    observer.response(
      callId,
      response.status,
      contentType,
      response.headers.get("x-request-id"),
    );
    if (!response.body) {
      release();
      void output?.finish();
      return response;
    }
    const reader = response.body.getReader();
    let abandoned = false;
    let cancelled = false,
      complete = false;
    // 只预读一个网络分片：及时观察真实 EOF，同时限制业务侧缓冲。
    // SDK 看到 [DONE] 会提前 return；只有真正读到 EOF 才能宣称采集完整。
    const readNext = () =>
      reader.read().then((item) => {
        if (item.done) {
          if (!cancelled) {
            complete = true;
            release();
            void output?.finish();
          }
        } else {
          observer.chunk(callId);
          output?.write(item.value);
        }
        return item;
      });
    let next = readNext();
    void next.catch(() => {});
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await next;
          if (abandoned) return;
          if (item.done) {
            controller.close();
            return;
          }
          next = readNext();
          void next.catch(() => {});
          controller.enqueue(item.value);
        } catch (error) {
          release();
          void output?.finish(
            init?.signal?.aborted ? "cancelled" : "stream_error",
          );
          controller.error(error);
        }
      },
      cancel(reason) {
        abandoned = true;
        const stop = () => {
          if (complete) return;
          cancelled = true;
          release();
          void output?.finish(
            controller?.signal.aborted ? "cancelled" : "reader_closed",
          );
          void reader.cancel(reason).catch(() => {});
        };
        if (output && sourceSignal && !sourceSignal.aborted && !complete) {
          // SDK 提前结束消费后，独立收拢已经在途的 HTTP 尾部。最多 150ms、始终只读一片；
          // 不等待磁盘、不阻塞模型返回，不发第二次请求，未见 EOF 明确保留 partial。
          void (async () => {
            const timer = setTimeout(stop, 150);
            timer.unref();
            try {
              let item = await next;
              while (!item.done && !cancelled) {
                next = readNext();
                item = await next;
              }
            } catch {
              if (!complete) {
                cancelled = true;
                void output.finish(
                  sourceSignal.aborted ? "cancelled" : "stream_error",
                );
              }
            } finally {
              clearTimeout(timer);
              release();
            }
          })();
          return;
        }
        stop();
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return Object.assign(request, { complete: () => release() });
}
/** 白名单解析计费用量；累计用量由账本替换保存，未知字段不流入日志或公开 DTO。 */
export function reportedUsage(
  value: unknown,
  protocol: "responses" | "chat_completions",
): Usage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const input = protocol === "responses" ? v.input_tokens : v.prompt_tokens;
  const output =
    protocol === "responses" ? v.output_tokens : v.completion_tokens;
  const total = v.total_tokens;
  const valid = (x: unknown): x is number =>
    typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
  if (
    !valid(input) ||
    !valid(output) ||
    !valid(total) ||
    total < input + output
  )
    return null;
  const inputs = (v.input_tokens_details ??
    v.prompt_tokens_details ??
    {}) as Record<string, unknown>;
  const outputs = (v.output_tokens_details ??
    v.completion_tokens_details ??
    {}) as Record<string, unknown>;
  const read = inputs.cached_tokens ?? v.prompt_cache_hit_tokens;
  const write = inputs.cache_write_tokens ?? v.cache_write_input_tokens;
  const reasoning = outputs.reasoning_tokens;
  if (
    (read !== undefined && (!valid(read) || read > input)) ||
    (write !== undefined && (!valid(write) || write > input)) ||
    (reasoning !== undefined && (!valid(reasoning) || reasoning > output))
  )
    return null;
  if (valid(read) && valid(write) && read + write > input) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(valid(read) ? { cacheReadTokens: read } : {}),
    ...(valid(write) ? { cacheWriteTokens: write } : {}),
    ...(valid(reasoning) ? { reasoningTokens: reasoning } : {}),
  };
}
