import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AppError,
  type ChatEvent,
  type EventData,
  type Message,
  type Run,
  type Session,
  type SessionSnapshot,
} from "@myagent/contracts";
import type {
  BeginRun,
  ChatStore,
  FinishRun,
  StoredSettings,
} from "@myagent/state";
import Database from "better-sqlite3";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as tables from "./schema.js";
export class SqliteChatStore implements ChatStore {
  private readonly raw: Database.Database;
  private readonly db;
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.raw = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.raw.pragma("busy_timeout = 5000");
    const version = this.raw.pragma("user_version", { simple: true }) as number;
    if (version > 1) {
      this.raw.close();
      throw new AppError(
        "schema_version",
        "数据库版本较新，请使用相应版本的 MyAgent。",
        500,
      );
    }
    if (version === 0)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL("../../../../../migrations/0001_chat.sql", import.meta.url),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 1");
      })();
    this.db = drizzle(this.raw);
    if (!this.db.select().from(tables.settings).get())
      this.db
        .insert(tables.settings)
        .values({
          id: 1,
          data: {
            baseUrl: "https://api.openai.com/v1",
            model: "",
            systemPrompt: "",
            credentialRef: null,
            revision: 0,
            updatedAt: new Date().toISOString(),
          },
        })
        .run();
  }
  private sessionRow(id: string) {
    const session = this.db
      .select()
      .from(tables.sessions)
      .where(eq(tables.sessions.id, id))
      .get();
    if (!session) throw new AppError("not_found", "会话不存在或已删除。", 404);
    return session;
  }
  private publicSession(row: typeof tables.sessions.$inferSelect): Session {
    const { seq: _, ...session } = row;
    return session;
  }
  private emit(id: string, event: EventData): void {
    const row = this.db
      .update(tables.sessions)
      .set({ seq: sql`${tables.sessions.seq} + 1` })
      .where(eq(tables.sessions.id, id))
      .returning()
      .get();
    if (!row) return;
    const data: ChatEvent = {
      ...event,
      schemaVersion: 1,
      sessionId: id,
      seq: row.seq,
      createdAt: new Date().toISOString(),
    };
    this.db
      .insert(tables.events)
      .values({ sessionId: id, seq: row.seq, data })
      .run();
  }
  private touch(id: string, title?: string): Session {
    const row = this.db
      .update(tables.sessions)
      .set({
        revision: sql`${tables.sessions.revision} + 1`,
        updatedAt: new Date().toISOString(),
        ...(title !== undefined ? { title } : {}),
      })
      .where(eq(tables.sessions.id, id))
      .returning()
      .get();
    if (!row) throw new AppError("not_found", "会话已删除。", 404);
    return this.publicSession(row);
  }
  settings(): StoredSettings {
    const row = this.db.select().from(tables.settings).get();
    if (!row) throw new Error("Missing settings");
    return row.data;
  }
  saveSettings(
    value: Omit<StoredSettings, "updatedAt" | "revision">,
    expectedRevision: number,
  ): StoredSettings {
    return this.raw.transaction(() => {
      const old = this.settings();
      if (old.revision !== expectedRevision)
        throw new AppError(
          "revision_conflict",
          "设置已更新，请重新加载。",
          409,
        );
      const data: StoredSettings = {
        ...value,
        revision: old.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.db
        .update(tables.settings)
        .set({ data })
        .where(eq(tables.settings.id, 1))
        .run();
      return data;
    })();
  }
  listSessions(): Session[] {
    return this.db
      .select()
      .from(tables.sessions)
      .orderBy(desc(tables.sessions.updatedAt))
      .all()
      .map((row) => this.publicSession(row));
  }
  createSession(): Session {
    const now = new Date().toISOString();
    const session = {
      id: randomUUID(),
      title: "新对话",
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .insert(tables.sessions)
      .values({ ...session, seq: 0 })
      .run();
    return session;
  }
  snapshot(id: string): SessionSnapshot {
    return this.raw.transaction(() => {
      const row = this.sessionRow(id);
      const messages = this.db
        .select()
        .from(tables.messages)
        .where(eq(tables.messages.sessionId, id))
        .orderBy(sql`rowid`)
        .all();
      const records = this.db
        .select()
        .from(tables.runs)
        .where(eq(tables.runs.sessionId, id))
        .orderBy(desc(sql`rowid`))
        .all();
      return {
        session: this.publicSession(row),
        messages,
        latestRun: records[0]?.data ?? null,
        activeRun:
          records.find((item) => item.status === "running")?.data ?? null,
        cursor: row.seq,
      };
    })();
  }
  renameSession(id: string, title: string, revision: number): Session {
    return this.raw.transaction(() => {
      if (!title.trim() || title.trim().length > 100)
        throw new AppError("invalid_input", "标题需要 1–100 字符。");
      if (this.sessionRow(id).revision !== revision)
        throw new AppError("revision_conflict", "会话已更新，请重试。", 409);
      const session = this.touch(id, title.trim());
      this.emit(id, { type: "session.updated", session });
      return session;
    })();
  }
  deleteSession(id: string): void {
    this.db.delete(tables.sessions).where(eq(tables.sessions.id, id)).run();
  }
  findRequest(sessionId: string, requestId: string): Run | null {
    return (
      this.db
        .select()
        .from(tables.runs)
        .where(
          and(
            eq(tables.runs.sessionId, sessionId),
            eq(tables.runs.requestId, requestId),
          ),
        )
        .get()?.data ?? null
    );
  }
  getRun(id: string): Run {
    const row = this.db
      .select()
      .from(tables.runs)
      .where(eq(tables.runs.id, id))
      .get();
    if (!row) throw new AppError("not_found", "运行不存在。", 404);
    return row.data;
  }
  beginRun(input: BeginRun): Run {
    return this.raw.transaction(() => {
      const old = this.snapshot(input.sessionId);
      if (old.activeRun)
        throw new AppError(
          "run_active",
          "当前会话正在生成，请等待或停止。",
          409,
        );
      if (old.session.revision !== input.expectedRevision)
        throw new AppError(
          "revision_conflict",
          "会话已在其他页面更新，请重试。",
          409,
        );
      const now = new Date().toISOString();
      const runId = randomUUID();
      const previousUser = old.messages.findLast(
        (message) => message.role === "user",
      );
      if (input.kind === "regenerate" && !previousUser)
        throw new AppError("invalid_input", "没有可重新生成的问题。");
      const userId =
        input.kind === "regenerate" && previousUser
          ? previousUser.id
          : randomUUID();
      const original =
        input.kind === "regenerate"
          ? old.messages.findLast(
              (message) =>
                message.replyToId === userId && message.status === "completed",
            )
          : undefined;
      const assistant: Message = {
        id: randomUUID(),
        sessionId: input.sessionId,
        runId,
        role: "assistant",
        content: "",
        status: "generating",
        replyToId: userId,
        createdAt: now,
      };
      const run: Run = {
        id: runId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        fingerprint: input.fingerprint,
        kind: input.kind,
        status: "running",
        userMessageId: userId,
        assistantMessageId: assistant.id,
        originalAssistantId: original?.id ?? null,
        model: input.model,
        contextTrimmed: input.contextTrimmed,
        finishReason: null,
        usage: null,
        error: null,
        createdAt: now,
        endedAt: null,
      };
      if (input.kind === "send") {
        const user: Message = {
          id: userId,
          sessionId: input.sessionId,
          runId,
          role: "user",
          content: input.content,
          status: "completed",
          replyToId: null,
          createdAt: now,
        };
        this.db.insert(tables.messages).values(user).run();
        this.emit(input.sessionId, { type: "message.created", message: user });
      }
      this.db.insert(tables.messages).values(assistant).run();
      this.db
        .insert(tables.runs)
        .values({
          id: runId,
          sessionId: input.sessionId,
          requestId: input.requestId,
          status: "running",
          data: run,
        })
        .run();
      const title =
        old.messages.length === 0 && old.session.title === "新对话"
          ? input.content.replace(/\s+/g, " ").slice(0, 32)
          : undefined;
      const session = this.touch(input.sessionId, title);
      this.emit(input.sessionId, {
        type: "message.created",
        message: assistant,
      });
      this.emit(input.sessionId, { type: "run.updated", run });
      this.emit(input.sessionId, { type: "session.updated", session });
      return run;
    })();
  }
  appendDelta(runId: string, delta: string): void {
    if (!delta) return;
    this.raw.transaction(() => {
      const run = this.db
        .select()
        .from(tables.runs)
        .where(eq(tables.runs.id, runId))
        .get()?.data;
      if (run?.status !== "running") return;
      this.db
        .update(tables.messages)
        .set({ content: sql`${tables.messages.content} || ${delta}` })
        .where(eq(tables.messages.id, run.assistantMessageId))
        .run();
      this.emit(run.sessionId, {
        type: "message.delta",
        messageId: run.assistantMessageId,
        delta,
      });
    })();
  }
  finishRun(runId: string, outcome: FinishRun): void {
    this.raw.transaction(() => {
      const old = this.db
        .select()
        .from(tables.runs)
        .where(eq(tables.runs.id, runId))
        .get()?.data;
      if (old?.status !== "running") return;
      const run: Run = {
        ...old,
        ...outcome,
        endedAt: new Date().toISOString(),
      };
      this.db
        .update(tables.runs)
        .set({ status: run.status, data: run })
        .where(eq(tables.runs.id, runId))
        .run();
      if (run.status === "succeeded" && run.originalAssistantId) {
        const previous = this.db
          .update(tables.messages)
          .set({ status: "superseded" })
          .where(eq(tables.messages.id, run.originalAssistantId))
          .returning()
          .get();
        if (previous)
          this.emit(run.sessionId, {
            type: "message.updated",
            message: previous,
          });
      }
      const message = this.db
        .update(tables.messages)
        .set({
          status: outcome.status === "succeeded" ? "completed" : outcome.status,
        })
        .where(eq(tables.messages.id, run.assistantMessageId))
        .returning()
        .get();
      if (message)
        this.emit(run.sessionId, { type: "message.updated", message });
      const session = this.touch(run.sessionId);
      this.emit(run.sessionId, { type: "run.updated", run });
      this.emit(run.sessionId, { type: "session.updated", session });
    })();
  }
  events(sessionId: string, after: number): ChatEvent[] {
    this.sessionRow(sessionId);
    return this.db
      .select()
      .from(tables.events)
      .where(
        and(
          eq(tables.events.sessionId, sessionId),
          gt(tables.events.seq, after),
        ),
      )
      .orderBy(tables.events.seq)
      .limit(1000)
      .all()
      .map((row) => row.data);
  }
  recoverInterrupted(): void {
    for (const row of this.db
      .select()
      .from(tables.runs)
      .where(eq(tables.runs.status, "running"))
      .all())
      this.finishRun(row.id, {
        status: "interrupted",
        finishReason: null,
        usage: null,
        error: {
          code: "interrupted",
          message: "上次生成因本地服务退出而中断，可手动重试。",
        },
      });
  }
  close(): void {
    this.raw.close();
  }
}
