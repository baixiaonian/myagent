/**
 * SQLite 工具事实仓储：与聊天仓储共享连接及同步事务，工具状态和 SSE 同时提交。
 * 泛型集合固定为协议声明的种类；SQL 参数始终绑定，不把模型字符串当表名或 SQL。
 */
import {
  AppError,
  type EventData,
  isActiveRun,
  type Run,
  type RunStatus,
  type ToolInvocation,
} from "@myagent/contracts";
import type {
  ExecutionFactIndex,
  ExecutionRecords,
  ExecutionStore,
  RecordFilter,
} from "@myagent/state";
import type Database from "better-sqlite3";

export class SqliteExecutionStore implements ExecutionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly emit: (sessionId: string, event: EventData) => void,
    private readonly bind: (
      sessionId: string,
      workspaceId: string,
      revision: number,
    ) => void,
  ) {}
  contextFacts(sessionId: string): ExecutionFactIndex {
    const count = (kind: string, condition: string) =>
      (
        this.db
          .prepare(
            `SELECT count(*) AS count FROM execution_records WHERE kind=? AND session_id=? AND ${condition}`,
          )
          .get(kind, sessionId) as { count: number }
      ).count;
    // condition 都是本方法内固定 SQL，不接受模型或 HTTP 字符串拼接。
    const effects = count(
      "invocations",
      "json_extract(data,'$.result.effectsPossible')=1",
    );
    const unresolved = count(
      "invocations",
      "json_extract(data,'$.status')='unknown' AND json_extract(data,'$.resolution') IS NULL",
    );
    const activeProcesses = count(
      "processes",
      "json_extract(data,'$.status') IN ('running','unknown')",
    );
    const invocations = this.db
      .prepare(
        `SELECT id AS sourceId,json_extract(data,'$.toolName') AS tool,json_extract(data,'$.status') AS status,json_extract(data,'$.result.resultRef') AS resultRef FROM execution_records WHERE kind='invocations' AND session_id=? AND (json_extract(data,'$.result.effectsPossible')=1 OR (json_extract(data,'$.status')='unknown' AND json_extract(data,'$.resolution') IS NULL)) ORDER BY (json_extract(data,'$.status')='unknown' AND json_extract(data,'$.resolution') IS NULL) DESC,rowid DESC LIMIT 20`,
      )
      .all(sessionId) as ExecutionFactIndex["invocations"];
    const processes = this.db
      .prepare(
        "SELECT id,json_extract(data,'$.status') AS status FROM execution_records WHERE kind='processes' AND session_id=? AND json_extract(data,'$.status') IN ('running','unknown') ORDER BY rowid DESC LIMIT 10",
      )
      .all(sessionId) as ExecutionFactIndex["processes"];
    return {
      effects,
      unresolved,
      activeProcesses,
      invocations,
      processes,
      more: effects > 20 || unresolved > 20 || activeProcesses > 10,
    };
  }
  get<K extends keyof ExecutionRecords>(
    kind: K,
    id: string,
  ): ExecutionRecords[K] | null {
    const row = this.db
      .prepare("SELECT data FROM execution_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ExecutionRecords[K]) : null;
  }
  list<K extends keyof ExecutionRecords>(
    kind: K,
    filter: RecordFilter = {},
  ): ExecutionRecords[K][] {
    const rows = this.db
      .prepare(
        "SELECT data FROM execution_records WHERE kind=? AND (? IS NULL OR session_id=?) AND (? IS NULL OR run_id=?) ORDER BY rowid",
      )
      .all(
        kind,
        filter.sessionId ?? null,
        filter.sessionId ?? null,
        filter.runId ?? null,
        filter.runId ?? null,
      ) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as ExecutionRecords[K]);
  }
  put<K extends keyof ExecutionRecords>(
    kind: K,
    record: ExecutionRecords[K],
  ): void {
    this.transaction(() => {
      const sessionId = "sessionId" in record ? record.sessionId : null;
      const runId = "runId" in record ? record.runId : null;
      if (
        sessionId &&
        !this.db.prepare("SELECT id FROM sessions WHERE id=?").get(sessionId)
      )
        throw new AppError("not_found", "会话已删除，拒绝迟到执行记录。", 404);
      if (runId) {
        const run = this.db
          .prepare("SELECT status FROM runs WHERE id=?")
          .get(runId) as { status: string } | undefined;
        if (!run || !isActiveRun(run.status))
          throw new AppError(
            "interrupted",
            "运行已结束，拒绝迟到执行记录。",
            409,
          );
      }
      this.db
        .prepare(
          "INSERT INTO execution_records(kind,id,session_id,run_id,data) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET session_id=excluded.session_id,run_id=excluded.run_id,data=excluded.data",
        )
        .run(kind, record.id, sessionId, runId, JSON.stringify(record));
      if (
        sessionId &&
        runId &&
        ["approvals", "invocations", "processes"].includes(kind)
      )
        this.emit(sessionId, { type: "execution.updated", runId });
    });
  }
  remove<K extends keyof ExecutionRecords>(kind: K, id: string): void {
    this.db
      .prepare("DELETE FROM execution_records WHERE kind=? AND id=?")
      .run(kind, id);
  }
  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }
  resolveInvocation(
    id: string,
    resolution: NonNullable<ToolInvocation["resolution"]>,
  ): ToolInvocation {
    return this.transaction(() => {
      const invocation = this.get("invocations", id);
      if (invocation?.status !== "unknown" || !invocation.result)
        throw new AppError(
          "invalid_resolution",
          "该调用不处于结果未知状态。",
          409,
        );
      invocation.resolution = resolution;
      invocation.result.modelContent = JSON.stringify({
        outcome: "unknown",
        originalError: invocation.result.error,
        resolution,
        verificationSource: "user",
        note: "用户判断不等于原服务回执。",
      });
      this.db
        .prepare(
          "UPDATE execution_records SET data=? WHERE kind='invocations' AND id=?",
        )
        .run(JSON.stringify(invocation), id);
      this.emit(invocation.sessionId, {
        type: "execution.updated",
        runId: invocation.runId,
      });
      return invocation;
    });
  }
  bindWorkspace(
    sessionId: string,
    workspaceId: string,
    expectedRevision: number,
  ): void {
    if (!this.get("workspaces", workspaceId))
      throw new AppError("not_found", "工作区不存在。", 404);
    this.bind(sessionId, workspaceId, expectedRevision);
  }
  setRunStatus(runId: string, status: RunStatus): void {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT data FROM runs WHERE id=?")
        .get(runId) as { data: string } | undefined;
      if (!row) throw new AppError("not_found", "运行不存在。", 404);
      const run = JSON.parse(row.data) as Run;
      if (!isActiveRun(run.status))
        throw new AppError("interrupted", "运行已经结束。", 409);
      if (!isActiveRun(status))
        throw new AppError("invalid_transition", "终态必须由聊天事务提交。");
      if (run.status === status) return;
      run.status = status;
      this.db
        .prepare("UPDATE runs SET status=?,data=? WHERE id=?")
        .run(status, JSON.stringify(run), runId);
      this.emit(run.sessionId, { type: "run.updated", run });
    });
  }
}
