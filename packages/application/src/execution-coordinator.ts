/** 工具与 Hook 共用的协调器：共享资源锁及全局槽位；每个真实动作独立加锁，Hook 链不是文件事务。 */
import { AppError, EXECUTION_LIMITS } from "@myagent/contracts";
import {
  ExecutionSemaphore,
  type ResourceLock,
  ResourceLockManager,
  resourceLocksConflict,
} from "@myagent/kernel";
export interface LockBlocker {
  runId: string;
  invocationId?: string;
  toolName?: string;
  processIds: string[];
  resources: readonly ResourceLock[];
}
export class ExecutionCoordinator {
  // 活动/排队租约仅用于实时诊断；持久执行事实仍由 invocation/attempt 保存。
  private readonly owners = new Map<
    readonly ResourceLock[],
    { runId: string; invocationId?: string; toolName?: string }
  >();
  constructor(private readonly lockWaitMs = 5000) {}
  readonly locks = new ResourceLockManager();
  readonly slots = new ExecutionSemaphore(EXECUTION_LIMITS.globalConcurrency);
  private readonly processes = new Map<
    string,
    { runId: string; keys: readonly ResourceLock[] }
  >();

  /** 已返回句柄的进程继续持锁，但所属 Run 不能排队等待自己；否则模型无法再读取/停止进程。 */
  acquire(
    runId: string,
    keys: readonly ResourceLock[],
    signal: AbortSignal,
    detail: {
      invocationId?: string;
      toolName?: string;
      onBlocked?: (blockers: LockBlocker[]) => void;
    } = {},
  ): Promise<() => void> {
    signal.throwIfAborted();
    const blockers = [...this.processes]
      .filter(
        ([, lease]) =>
          lease.runId === runId && resourceLocksConflict(keys, lease.keys),
      )
      .map(([id]) => id);
    if (blockers.length)
      throw new AppError(
        "process_resource_busy",
        `本次动作尚未执行：当前 Run 的进程 ${blockers.join("、")} 仍占用所需资源。请先用 read_process 读取/等待，或用 stop_process 停止，再决定是否重新调用；不要连续提交冲突动作。`,
        409,
      );
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let blocked: LockBlocker[] = [];
    let blockedLeases: readonly (readonly ResourceLock[])[] = [];
    const refresh = () =>
      blockedLeases.map((lease) => ({
        ...(this.owners.get(lease) ?? { runId: "unknown" }),
        processIds: [...this.processes]
          .filter(([, p]) => p.keys === lease)
          .map(([id]) => id),
        resources: lease,
      }));
    let previous = "";
    this.owners.set(keys, {
      runId,
      ...(detail.invocationId ? { invocationId: detail.invocationId } : {}),
      ...(detail.toolName ? { toolName: detail.toolName } : {}),
    });
    // 队列超时只终结尚未派发的工具，不杀持锁进程，也不终止整个 Run。
    // 采用事件通知而非轮询；取消时立即移除队列，迟到授锁不能泄漏租约。
    return this.locks
      .acquire(keys, controller.signal, (leases) => {
        blockedLeases = leases;
        blocked = refresh();
        const serialized = JSON.stringify(blocked);
        if (serialized !== previous) {
          previous = serialized;
          detail.onBlocked?.(blocked);
        }
        timer ??= setTimeout(() => {
          // 短命令可能在排队期间才转为后台进程，诊断必须取得最新进程身份。
          blocked = refresh();
          detail.onBlocked?.(blocked);
          controller.abort(
            new AppError(
              "resource_busy",
              `本次动作尚未执行：资源等待超过 ${this.lockWaitMs}ms。持锁/前序请求：${JSON.stringify(blocked)}。同团队请用 list_agents 定位成员并 send_message 协调，再用 wait_agents 等待事件；不要用 sleep 轮询，也不要连续重复冲突调用。进程只能由所属 Run 用 read_process/stop_process 管理。`,
              409,
            ),
          );
        }, this.lockWaitMs);
      })
      .then(
        (release) => {
          let released = false;
          return () => {
            if (released) return;
            released = true;
            this.owners.delete(keys);
            release();
          };
        },
        (error: unknown) => {
          this.owners.delete(keys);
          throw error;
        },
      )
      .finally(() => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      });
  }

  /** 持有项目进程锁时不能挂起等待其他成员；对方可能正在等该锁写出结果。 */
  waitConflict(runId: string): string | undefined {
    const processes = [...this.processes].filter(
      ([, p]) =>
        p.runId === runId && p.keys.some((k) => k.key.startsWith("path:")),
    );
    if (!processes.length) return;
    return `当前 Run 的进程 ${processes.map(([id]) => id).join("、")} 仍持有项目资源锁，等待成员可能阻塞对方完成。请先 read_process 确认退出或 stop_process 停止这些进程，再使用 wait_agents；不要启动 sleep 轮询文件。`;
  }

  /** 注册保留锁和包装释放必须同步完成，只有确认进程退出/收拢后才允许其他动作进入。 */
  retainProcess(
    runId: string,
    processId: string,
    keys: readonly ResourceLock[],
    release: () => void,
  ): () => void {
    this.processes.set(processId, { runId, keys });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.processes.delete(processId);
      release();
    };
  }
}
