/** 团队 SQLite 仓储：与 Run 创建共享事务，操作日志保留幂等结果；会话删除仅移除本轮引用。 */
import type { TeamRecords, TeamStore } from "@myagent/state";
import type Database from "better-sqlite3";
export class SqliteTeamStore implements TeamStore {
  constructor(
    private readonly db: Database.Database,
    readonly notify: (sessionId: string, runId: string) => void,
  ) {}
  get<K extends keyof TeamRecords>(kind: K, id: string): TeamRecords[K] | null {
    const row = this.db
      .prepare("SELECT data FROM team_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as TeamRecords[K]) : null;
  }
  list<K extends keyof TeamRecords>(kind: K): TeamRecords[K][] {
    return (
      this.db
        .prepare("SELECT data FROM team_records WHERE kind=? ORDER BY id")
        .all(kind) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as TeamRecords[K]);
  }
  put<K extends keyof TeamRecords>(kind: K, value: TeamRecords[K]): void {
    this.db
      .prepare(
        "INSERT INTO team_records(kind,id,session_id,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(
        kind,
        value.id,
        "sessionId" in value ? value.sessionId : null,
        JSON.stringify(value),
      );
  }
  delete(kind: keyof TeamRecords, id: string): void {
    this.db
      .prepare("DELETE FROM team_records WHERE kind=? AND id=?")
      .run(kind, id);
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
