/**
 * 有界调度与共享资源锁：跨会话复用锁管理器，排他工具形成模型顺序屏障。
 * 锁请求原子获取全部资源，避免多文件操作因获取次序产生死锁；等待不占执行并发额度。
 */
import { AppError } from "@myagent/contracts";
import { containsPath } from "./policy.js";

export interface ResourceLock {
  key: string;
  mode: "read" | "write";
}
function conflicts(a: ResourceLock, b: ResourceLock): boolean {
  if (a.mode === "read" && b.mode === "read") return false;
  return (
    a.key === b.key ||
    (a.key.startsWith("path:") &&
      b.key.startsWith("path:") &&
      (containsPath(a.key.slice(5), b.key.slice(5)) ||
        containsPath(b.key.slice(5), a.key.slice(5))))
  );
}
/** 同一份资源冲突语义供锁队列与保留进程锁检查复用，避免父子目录边界不一致。 */
export function resourceLocksConflict(
  left: readonly ResourceLock[],
  right: readonly ResourceLock[],
): boolean {
  return left.some((a) => right.some((b) => conflicts(a, b)));
}
export class ResourceLockManager {
  private readonly held = new Set<readonly ResourceLock[]>();
  private readonly queue: {
    keys: readonly ResourceLock[];
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
    onBlocked?: (blockers: readonly (readonly ResourceLock[])[]) => void;
  }[] = [];
  acquire(
    keys: readonly ResourceLock[],
    signal: AbortSignal,
    onBlocked?: (blockers: readonly (readonly ResourceLock[])[]) => void,
  ): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const item = {
        keys,
        resolve,
        reject,
        signal,
        abort: () => {},
        ...(onBlocked ? { onBlocked } : {}),
      };
      item.abort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason ?? new AppError("cancelled", "等待执行已取消。"));
        this.drain();
      };
      signal.addEventListener("abort", item.abort, { once: true });
      this.queue.push(item);
      this.drain();
    });
  }
  private drain(): void {
    for (let index = 0; index < this.queue.length; ) {
      const item = this.queue[index];
      if (!item) break;
      // 不允许后来读请求越过更早的冲突写请求，避免写者长期饿死。
      const blockers = [
        ...this.held,
        ...this.queue.slice(0, index).map((entry) => entry.keys),
      ];
      const conflicting = blockers.filter((keys) =>
        resourceLocksConflict(keys, item.keys),
      );
      if (conflicting.length) {
        item.onBlocked?.(conflicting);
        index++;
        continue;
      }
      this.queue.splice(index, 1);
      item.signal.removeEventListener("abort", item.abort);
      this.held.add(item.keys);
      let released = false;
      item.resolve(() => {
        if (!released) {
          released = true;
          this.held.delete(item.keys);
          this.drain();
        }
      });
    }
  }
}
export class ExecutionSemaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async use<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(signal.reason);
        };
        this.waiters.push(wake);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
/** 只读段有限并行，排他项单独执行；失败停止补充，已开始任务先收拢再抛出。 */
export async function scheduleBatch<T>(
  items: readonly T[],
  shared: (item: T) => boolean,
  execute: (item: T, index: number) => Promise<void>,
  limit: number,
  signal: AbortSignal,
): Promise<void> {
  let next = 0;
  while (next < items.length) {
    signal.throwIfAborted();
    const start = next;
    const first = items[next];
    if (first === undefined) break;
    if (!shared(first)) {
      await execute(first, next++);
      continue;
    }
    while (next < items.length && shared(items[next] as T)) next++;
    let cursor = start;
    let error: unknown;
    const workers = Array.from(
      { length: Math.min(limit, next - start) },
      async () => {
        while (cursor < next && error === undefined && !signal.aborted) {
          const index = cursor++;
          try {
            await execute(items[index] as T, index);
          } catch (cause) {
            error = cause;
          }
        }
      },
    );
    await Promise.all(workers);
    if (error !== undefined) throw error;
    signal.throwIfAborted();
  }
}
