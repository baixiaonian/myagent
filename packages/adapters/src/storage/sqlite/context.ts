/**
 * SQLite 上下文仓储：与聊天共享事务；公开历史使用白名单投影，不展开私有 StoredStep。
 * 游标绑定会话与查询指纹，单条长记录也能续读；所有 SQL 值均参数化。
 */
import { createHash } from "node:crypto";
import {
  AppError,
  type EventData,
  type HistoryPage,
  type HistoryQuery,
  isActiveRun,
} from "@myagent/contracts";
import { wholeCharacterEnd } from "@myagent/kernel";
import type { ContextRecords, ContextStore } from "@myagent/state";
import type Database from "better-sqlite3";
export class SqliteContextStore implements ContextStore {
  constructor(
    private readonly db: Database.Database,
    private readonly emit: (id: string, event: EventData) => void,
  ) {}
  get<K extends keyof ContextRecords>(
    kind: K,
    id: string,
  ): ContextRecords[K] | null {
    const row = this.db
      .prepare("SELECT data FROM context_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ContextRecords[K]) : null;
  }
  list<K extends keyof ContextRecords>(
    kind: K,
    sessionId: string,
  ): ContextRecords[K][] {
    return (
      this.db
        .prepare(
          "SELECT data FROM context_records WHERE kind=? AND session_id=? ORDER BY rowid",
        )
        .all(kind, sessionId) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as ContextRecords[K]);
  }
  put<K extends keyof ContextRecords>(
    kind: K,
    record: ContextRecords[K],
  ): void {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT status FROM runs WHERE id=? AND session_id=?")
        .get(record.runId, record.sessionId) as { status: string } | undefined;
      if (!row || !isActiveRun(row.status))
        throw new AppError("interrupted", "运行已结束，拒绝迟到上下文。", 409);
      this.db
        .prepare(
          "INSERT INTO context_records(kind,id,session_id,run_id,data) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,run_id=excluded.run_id",
        )
        .run(
          kind,
          record.id,
          record.sessionId,
          record.runId,
          JSON.stringify(record),
        );
      if (kind === "runs")
        this.emit(record.sessionId, {
          type: "context.updated",
          runId: record.runId,
        });
    });
  }
  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }
  recover(): void {
    this.transaction(() => {
      for (const row of this.db
        .prepare(
          "SELECT kind,id,data FROM context_records WHERE kind IN ('jobs','runs')",
        )
        .all() as { kind: string; id: string; data: string }[]) {
        const data = JSON.parse(row.data);
        if (row.kind === "jobs" && data.status === "running") {
          data.status = "interrupted";
          data.error = "服务重启，摘要未发布。";
        } else if (row.kind === "runs" && data.view.status === "compacting") {
          data.view.status = "interrupted";
          data.generation++;
        } else continue;
        this.db
          .prepare("UPDATE context_records SET data=? WHERE kind=? AND id=?")
          .run(JSON.stringify(data), row.kind, row.id);
      }
    });
  }
  history(sessionId: string, query: HistoryQuery): HistoryPage {
    if (!this.db.prepare("SELECT id FROM sessions WHERE id=?").get(sessionId))
      throw new AppError("not_found", "会话不存在。", 404);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          sessionId,
          query.query ?? "",
          query.sourceId ?? "",
          query.includeSuperseded ?? false,
        ]),
      )
      .digest("hex");
    let page = 0,
      offset = 0;
    let partialId: string | undefined;
    let partialHash: string | undefined;
    if (query.cursor) {
      try {
        const c = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (
          c.f !== fingerprint ||
          !Number.isSafeInteger(c.p) ||
          !Number.isSafeInteger(c.o) ||
          c.p < 0 ||
          c.o < 0
        )
          throw Error();
        page = c.p;
        offset = c.o;
        partialId = c.r;
        partialHash = c.h;
      } catch {
        throw new AppError("invalid_cursor", "历史游标无效，请从第一页读取。");
      }
    }
    const limit = Math.min(20, Math.max(1, query.limit ?? 20));
    // 只选择可见字段；reasoning/continuation、模型设置和内部凭证引用不属于历史工具。
    const cte = `WITH history AS (
      SELECT id AS sourceId,run_id AS runId,role AS kind,status,content AS text,created_at AS created FROM messages WHERE session_id=@session
      UNION ALL SELECT id,run_id,'step',json_extract(data,'$.step.status'),json_object('content',json_extract(data,'$.step.content'),'tools',json_extract(data,'$.step.tools')),json_extract(data,'$.step.createdAt') FROM run_steps WHERE session_id=@session
      UNION ALL SELECT id,run_id,'invocation',json_extract(data,'$.status'),json_object('tool',json_extract(data,'$.toolName'),'arguments',json_extract(data,'$.arguments'),'result',json_extract(data,'$.result.modelContent'),'resultRef',json_extract(data,'$.result.resultRef'),'resolution',json_extract(data,'$.resolution')),json_extract(data,'$.createdAt') FROM execution_records WHERE kind='invocations' AND session_id=@session
      UNION ALL SELECT id,run_id,'hook',json_extract(data,'$.status'),json_object('event',json_extract(data,'$.event'),'hook',json_extract(data,'$.hookId'),'context',json_extract(data,'$.output.additionalContext'),'error',json_extract(data,'$.error'),'resultRef',json_extract(data,'$.resultRef')),json_extract(data,'$.createdAt') FROM hook_records WHERE kind='events' AND session_id=@session
      UNION ALL SELECT id,run_id,'context','completed',json_extract(data,'$.value.content'),json_extract(data,'$.value.createdAt') FROM context_records WHERE kind='artifacts' AND session_id=@session AND json_extract(data,'$.value.kind')='execution_context'
    ) SELECT *,CASE WHEN kind='user' THEN NULL ELSE (SELECT m.status FROM messages m WHERE m.run_id=history.runId AND m.role='assistant' LIMIT 1) END AS answerStatus FROM history WHERE (@source='' OR sourceId=@source) AND (@query='' OR instr(lower(text),lower(@query))>0) AND (@all=1 OR (status NOT IN ('superseded','failed','cancelled','interrupted') AND (kind='user' OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.run_id=history.runId AND m.role='assistant' AND m.status='superseded')))) ORDER BY created,sourceId LIMIT @limit OFFSET @page`;
    const rows = this.db.prepare(cte).all({
      session: sessionId,
      source: query.sourceId ?? "",
      query: query.query ?? "",
      all: query.includeSuperseded ? 1 : 0,
      limit: limit + 1,
      page,
    }) as {
      sourceId: string;
      runId: string;
      kind: "user" | "assistant" | "step" | "invocation" | "hook" | "context";
      status: string;
      text: string;
    }[];
    const entries: HistoryPage["entries"] = [];
    let remaining = 8000,
      nextCursor: string | null = null;
    for (const row of rows.slice(0, limit)) {
      const rowHash = createHash("sha256").update(row.text).digest("hex");
      if (offset && (partialId !== row.sourceId || partialHash !== rowHash))
        throw new AppError(
          "invalid_cursor",
          "历史记录已变化，请重新读取该来源。",
        );
      const text = row.text.slice(
        offset,
        wholeCharacterEnd(row.text, offset + remaining),
      );
      const truncated = offset + text.length < row.text.length;
      // 引用只从显式字段取，不把 arbitrary 正文中的“resultRef”当成本地身份。
      const refs = this.db
        .prepare(
          "SELECT json_extract(data,'$.result.resultRef') AS ref FROM execution_records WHERE kind='invocations' AND session_id=? AND (id=? OR json_extract(data,'$.stepId')=?)",
        )
        .all(sessionId, row.sourceId, row.sourceId) as { ref: string | null }[];
      entries.push({
        ...row,
        text,
        offset,
        truncated,
        resultRefs: refs.flatMap((r) => (r.ref ? [r.ref] : [])),
      });
      remaining -= text.length;
      if (truncated) {
        offset += text.length;
        nextCursor = Buffer.from(
          JSON.stringify({
            f: fingerprint,
            p: page,
            o: offset,
            r: row.sourceId,
            h: rowHash,
          }),
        ).toString("base64url");
        break;
      }
      page++;
      offset = 0;
      if (!remaining) break;
    }
    if (!nextCursor && rows.length > entries.length)
      nextCursor = Buffer.from(
        JSON.stringify({ f: fingerprint, p: page, o: 0 }),
      ).toString("base64url");
    return { entries, nextCursor };
  }
}
