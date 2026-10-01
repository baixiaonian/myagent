/** SQLite Hook 仓储：共享聊天事务，删除会话级联删除 Run 引用，包由引用回收而不是重复存入每条消息。 */

import { AppError, type EventData, isActiveRun } from "@myagent/contracts";
import type { HookRecords, HookStore } from "@myagent/state";
import type Database from "better-sqlite3";
export class SqliteHookStore implements HookStore {
  constructor(
    private readonly db: Database.Database,
    private readonly emit: (sessionId: string, event: EventData) => void,
  ) {}
  get<K extends keyof HookRecords>(kind: K, id: string): HookRecords[K] | null {
    const row = this.db
      .prepare("SELECT data FROM hook_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as HookRecords[K]) : null;
  }
  list<K extends keyof HookRecords>(
    kind: K,
    filter: { sessionId?: string; runId?: string } = {},
  ): HookRecords[K][] {
    return (
      this.db
        .prepare(
          "SELECT data FROM hook_records WHERE kind=? AND (? IS NULL OR session_id=?) AND (? IS NULL OR run_id=?) ORDER BY rowid",
        )
        .all(
          kind,
          filter.sessionId ?? null,
          filter.sessionId ?? null,
          filter.runId ?? null,
          filter.runId ?? null,
        ) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as HookRecords[K]);
  }
  put<K extends keyof HookRecords>(kind: K, value: HookRecords[K]): void {
    this.transaction(() => {
      const sessionId = "sessionId" in value ? value.sessionId : null;
      const runId = "runId" in value ? value.runId : null;
      if (runId) {
        const row = this.db
          .prepare("SELECT status FROM runs WHERE id=?")
          .get(runId) as { status: string } | undefined;
        if (!row || !isActiveRun(row.status))
          throw new AppError(
            "interrupted",
            "运行已经结束，拒绝迟到 Hook 写入。",
            409,
          );
      }
      this.db
        .prepare(
          "INSERT INTO hook_records(kind,id,session_id,run_id,data) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
        )
        .run(kind, value.id, sessionId, runId, JSON.stringify(value));
      if (sessionId && runId)
        this.emit(sessionId, { type: "hook.updated", runId });
    });
  }

  delete(kind: keyof HookRecords, id: string): void {
    this.db
      .prepare("DELETE FROM hook_records WHERE kind=? AND id=?")
      .run(kind, id);
  }
  transaction<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn)();
    } catch (error) {
      // 持久层失败不是脚本故障：上层必须暂停恢复，不能按 Post/End 的警告策略继续派发。
      if (error instanceof AppError) throw error;
      throw new AppError(
        "execution_storage",
        "Hook 执行记录保存失败，已停止后续动作，请检查数据目录后恢复。",
        500,
      );
    }
  }
}
