/** SQLite Skill 仓储：共享聊天事务，删除会话级联删除 Run 引用，包由引用回收而不是重复存入每条消息。 */

import type { SkillRecords, SkillStore } from "@myagent/state";
import type Database from "better-sqlite3";
export class SqliteSkillStore implements SkillStore {
  constructor(private readonly db: Database.Database) {}
  get<K extends keyof SkillRecords>(
    kind: K,
    id: string,
  ): SkillRecords[K] | null {
    const row = this.db
      .prepare("SELECT data FROM skill_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as SkillRecords[K]) : null;
  }
  list<K extends keyof SkillRecords>(kind: K): SkillRecords[K][] {
    return (
      this.db
        .prepare("SELECT data FROM skill_records WHERE kind=? ORDER BY id")
        .all(kind) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as SkillRecords[K]);
  }
  put<K extends keyof SkillRecords>(kind: K, value: SkillRecords[K]): void {
    this.db
      .prepare(
        "INSERT INTO skill_records(kind,id,session_id,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(
        kind,
        value.id,
        "sessionId" in value ? value.sessionId : null,
        JSON.stringify(value),
      );
  }
  delete(kind: keyof SkillRecords, id: string): void {
    this.db
      .prepare("DELETE FROM skill_records WHERE kind=? AND id=?")
      .run(kind, id);
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
