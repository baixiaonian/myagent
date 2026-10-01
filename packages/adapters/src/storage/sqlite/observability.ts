/** SQLite 观测仓储：元数据索引与 DTO 同步保存，配置幂等与匿名化复用同步事务。 */
import { AppError, type ObservationSettings } from "@myagent/contracts";
import type {
  ObservationFilter,
  ObservationRecords,
  ObservationStore,
} from "@myagent/state";
import type Database from "better-sqlite3";
export class SqliteObservationStore implements ObservationStore {
  private readonly pending = new Map<
    string,
    {
      kind: keyof ObservationRecords;
      value: ObservationRecords[keyof ObservationRecords];
    }
  >();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dropped = 0;
  /** 诊断记录最长 250ms 合批；账本、配置、材料索引仍立即提交。 */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.size) return;
    const values = [...this.pending.values()];
    this.pending.clear();
    try {
      this.db.transaction(() => {
        for (const { kind, value } of values) this.write(kind, value);
      })();
    } catch {
      this.dropped += values.length;
    }
  }
  diagnostics() {
    return { dropped: this.dropped };
  }
  constructor(private readonly db: Database.Database) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO observation_settings(id,data) VALUES(1,?)",
      )
      .run(
        JSON.stringify({
          revision: 0,
          debug: false,
          retentionDays: 30,
          startedAt: new Date().toISOString(),
        }),
      );
  }
  get<K extends keyof ObservationRecords>(
    kind: K,
    id: string,
  ): ObservationRecords[K] | null {
    const pending = this.pending.get(`${kind}:${id}`);
    if (pending) return structuredClone(pending.value) as ObservationRecords[K];
    const row = this.db
      .prepare("SELECT data FROM observation_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  list<K extends keyof ObservationRecords>(
    kind: K,
    filter: ObservationFilter = {},
  ): ObservationRecords[K][] {
    if (
      filter.limit !== undefined ||
      filter.model ||
      filter.purpose ||
      filter.from ||
      filter.to
    )
      this.flush();
    const clauses = ["kind=?"],
      args = [kind as string];
    for (const [key, column] of [
      ["traceId", "trace_id"],
      ["sessionId", "session_id"],
      ["runId", "run_id"],
      ["callId", "call_id"],
    ] as const)
      if (filter[key]) {
        clauses.push(`${column}=?`);
        args.push(filter[key]!);
      }
    for (const [key, expression] of [
      ["model", "json_extract(data,'$.model')"],
      ["purpose", "json_extract(data,'$.scope.purpose')"],
    ] as const)
      if (filter[key]) {
        clauses.push(`${expression}=?`);
        args.push(filter[key]!);
      }
    if (filter.from) {
      clauses.push("created_at>=?");
      args.push(filter.from);
    }
    if (filter.to) {
      clauses.push("created_at<=?");
      args.push(filter.to);
    }
    const pagination =
      filter.limit === undefined
        ? ""
        : ` LIMIT ${Math.max(1, Math.min(10000, Math.floor(filter.limit)))} OFFSET ${Math.max(0, Math.floor(filter.offset ?? 0))}`;
    const rows = (
      this.db
        .prepare(
          `SELECT data FROM observation_records WHERE ${clauses.join(" AND ")} ORDER BY created_at,id${pagination}`,
        )
        .all(...args) as { data: string }[]
    ).map((row) => JSON.parse(row.data)) as ObservationRecords[K][];
    const values = new Map(rows.map((row) => [row.id, row]));
    for (const pending of this.pending.values())
      if (pending.kind === kind) {
        const d = pending.value as {
          id: string;
          traceId?: string;
          callId?: string;
          scope?: { runId?: string; sessionId?: string };
        };
        if (
          (!filter.traceId ||
            (kind === "traces" ? d.id : d.traceId) === filter.traceId) &&
          (!filter.sessionId || d.scope?.sessionId === filter.sessionId) &&
          (!filter.runId || d.scope?.runId === filter.runId) &&
          (!filter.callId || d.callId === filter.callId)
        )
          values.set(
            d.id,
            structuredClone(pending.value) as ObservationRecords[K],
          );
      }
    const at = (v: unknown) => {
      const d = v as { createdAt?: string; startedAt?: string; at?: string };
      return d.createdAt ?? d.startedAt ?? d.at ?? "";
    };
    return [...values.values()].sort(
      (a, b) => at(a).localeCompare(at(b)) || a.id.localeCompare(b.id),
    );
  }
  put<K extends keyof ObservationRecords>(
    kind: K,
    value: ObservationRecords[K],
  ): void {
    if (
      ["traces", "spans", "events"].includes(kind) &&
      !this.db.inTransaction
    ) {
      const key = `${kind}:${value.id}`;
      if (this.pending.size >= 4096 && !this.pending.has(key)) {
        this.dropped++;
        return;
      }
      this.pending.set(key, { kind, value: structuredClone(value) });
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), 250);
        this.timer.unref();
      }
      return;
    }
    this.pending.delete(`${kind}:${value.id}`);
    this.write(kind, value);
  }
  private write<K extends keyof ObservationRecords>(
    kind: K,
    value: ObservationRecords[K],
  ): void {
    const data = value as unknown as {
      id: string;
      traceId?: string;
      scope?: { sessionId?: string; runId?: string };
      callId?: string;
      createdAt?: string;
      startedAt?: string;
      at?: string;
    };
    this.db
      .prepare(
        "INSERT INTO observation_records(kind,id,trace_id,session_id,run_id,call_id,created_at,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET trace_id=excluded.trace_id,session_id=excluded.session_id,run_id=excluded.run_id,call_id=excluded.call_id,data=excluded.data",
      )
      .run(
        kind,
        data.id,
        kind === "traces" ? data.id : (data.traceId ?? null),
        data.scope?.sessionId ?? null,
        data.scope?.runId ?? null,
        data.callId ?? null,
        data.createdAt ?? data.startedAt ?? data.at ?? new Date().toISOString(),
        JSON.stringify(value),
      );
  }
  remove(kind: keyof ObservationRecords, id: string): void {
    this.pending.delete(`${kind}:${id}`);
    this.db
      .prepare("DELETE FROM observation_records WHERE kind=? AND id=?")
      .run(kind, id);
  }
  transaction<T>(action: () => T): T {
    this.flush();
    return this.db.transaction(action)();
  }
  settings(): ObservationSettings {
    return JSON.parse(
      (
        this.db
          .prepare("SELECT data FROM observation_settings WHERE id=1")
          .get() as { data: string }
      ).data,
    );
  }
  saveSettings(value: ObservationSettings): void {
    this.db
      .prepare("UPDATE observation_settings SET data=? WHERE id=1")
      .run(JSON.stringify(value));
  }
  operation<T>(id: string, fingerprint: string, action: () => T): T {
    return this.transaction(() => {
      const old = this.db
        .prepare(
          "SELECT fingerprint,result FROM observation_operations WHERE id=?",
        )
        .get(id) as { fingerprint: string; result: string } | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new AppError(
            "idempotency_conflict",
            "同一请求标识不能提交不同修改。",
            409,
          );
        return JSON.parse(old.result);
      }
      const result = action();
      this.db
        .prepare("INSERT INTO observation_operations VALUES(?,?,?)")
        .run(id, fingerprint, JSON.stringify(result));
      return result;
    });
  }
}
