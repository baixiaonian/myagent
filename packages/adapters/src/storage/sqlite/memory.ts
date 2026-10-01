/** SQLite 长期记忆状态与索引：共享聊天数据库和事务，不把投影当作 Markdown 正文的第二事实源。 */
import type { MemoryRecords, MemoryStore } from "@myagent/state";
import type Database from "better-sqlite3";
export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly db: Database.Database) {}
  get<K extends keyof MemoryRecords>(
    kind: K,
    id: string,
  ): MemoryRecords[K] | null {
    const row = this.db
      .prepare("SELECT data FROM memory_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as MemoryRecords[K]) : null;
  }
  list<K extends keyof MemoryRecords>(kind: K): MemoryRecords[K][] {
    return (
      this.db
        .prepare("SELECT data FROM memory_records WHERE kind=? ORDER BY rowid")
        .all(kind) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as MemoryRecords[K]);
  }
  put<K extends keyof MemoryRecords>(kind: K, record: MemoryRecords[K]): void {
    this.db
      .prepare(
        "INSERT INTO memory_records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, record.id, JSON.stringify(record));
  }
  remove(kind: keyof MemoryRecords, id: string): void {
    this.db
      .prepare("DELETE FROM memory_records WHERE kind=? AND id=?")
      .run(kind, id);
  }
  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }
}
