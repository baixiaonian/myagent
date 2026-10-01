/** 轻量团队协调原语：公平的请求队列和等待环检测；不调用模型、不定义第二套 Agent 循环。 */
import { AppError } from "@myagent/contracts";
/** FIFO 名额在请求结束或取消时归还；等待者取消会从队列移除，不能阻塞后来的成员。 */
export class TeamCoordinator {
  private active = 0;
  private queue: {
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    cancel: () => void;
  }[] = [];
  constructor(readonly concurrency = 4) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new AppError("invalid_limits", "模型并发必须为正整数。");
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const item = {
        signal,
        resolve,
        reject,
        cancel: () => {
          this.queue = this.queue.filter((x) => x !== item);
          reject(signal.reason);
          this.drain();
        },
      };
      signal.addEventListener("abort", item.cancel, { once: true });
      this.queue.push(item);
      this.drain();
    });
  }
  private drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const item = this.queue.shift()!;
      item.signal.removeEventListener("abort", item.cancel);
      if (item.signal.aborted) {
        item.reject(item.signal.reason);
        continue;
      }
      this.active++;
      let released = false;
      item.resolve(() => {
        if (!released) {
          released = true;
          this.active--;
          this.drain();
        }
      });
    }
  }
}
/** 只报告等待关系形成的环，不替模型决定如何拆分任务。 */
export function createsWaitCycle(
  source: string,
  targets: string[],
  edges: Map<string, string[]>,
): boolean {
  const visit = (node: string, seen: Set<string>): boolean => {
    if (node === source) return true;
    if (seen.has(node)) return false;
    seen.add(node);
    return (edges.get(node) ?? []).some((next) => visit(next, seen));
  };
  return targets.some((target) => visit(target, new Set()));
}
