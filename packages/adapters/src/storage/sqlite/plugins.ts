/** 插件 SQLite 仓储：与 Run 创建共享事务，操作日志保留幂等结果；会话删除仅移除本轮引用。 */
import type { PluginRecords, PluginStore } from "@myagent/state";
import type Database from "better-sqlite3";
export class SqlitePluginStore implements PluginStore {
  constructor(private readonly db: Database.Database) {}
  get<K extends keyof PluginRecords>(
    kind: K,
    id: string,
  ): PluginRecords[K] | null {
    const row = this.db
      .prepare("SELECT data FROM plugin_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as PluginRecords[K]) : null;
  }
  list<K extends keyof PluginRecords>(kind: K): PluginRecords[K][] {
    return (
      this.db
        .prepare("SELECT data FROM plugin_records WHERE kind=? ORDER BY id")
        .all(kind) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as PluginRecords[K]);
  }
  put<K extends keyof PluginRecords>(kind: K, value: PluginRecords[K]): void {
    this.db
      .prepare(
        "INSERT INTO plugin_records(kind,id,session_id,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(
        kind,
        value.id,
        "sessionId" in value ? value.sessionId : null,
        JSON.stringify(value),
      );
  }
  delete(kind: keyof PluginRecords, id: string): void {
    this.db
      .prepare("DELETE FROM plugin_records WHERE kind=? AND id=?")
      .run(kind, id);
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
