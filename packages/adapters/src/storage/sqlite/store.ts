/**
 * SQLite 聊天仓储：实现 ChatStore、初始迁移、会话 / Run 事务和持久事件日志。
 * 每次可见状态修改与对应事件同事务提交；revision 用于命令并发，seq 用于 SSE 补读。
 * 所有方法同步完成，事务内不等待模型；已结束或删除的 Run 不接受迟到写入。
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AppError,
  type ChatEvent,
  CONTEXT_DEFAULTS,
  type EventData,
  isActiveRun,
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
  StoredStep,
} from "@myagent/state";
import Database from "better-sqlite3";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { SqliteContextStore } from "./context.js";
import { SqliteExecutionStore } from "./execution.js";
import { SqliteHookStore } from "./hooks.js";
import { SqliteMemoryStore } from "./memory.js";
import { SqliteObservationStore } from "./observability.js";
import { SqlitePluginStore } from "./plugins.js";
import * as tables from "./schema.js";
import { SqliteSkillStore } from "./skills.js";
import { SqliteTeamStore } from "./teams.js";
export class SqliteChatStore implements ChatStore {
  readonly observations: SqliteObservationStore;
  readonly context: SqliteContextStore;
  readonly execution: SqliteExecutionStore;
  readonly memory: SqliteMemoryStore;
  readonly hooks: SqliteHookStore;
  readonly plugins: SqlitePluginStore;
  readonly teams: SqliteTeamStore;
  readonly skills: SqliteSkillStore;
  private readonly raw: Database.Database;
  private readonly db;
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.raw = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    // WAL 支持读写并行；外键启用后删除会话才能级联清理消息、运行和事件。
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.raw.pragma("busy_timeout = 5000");
    const version = this.raw.pragma("user_version", { simple: true }) as number;
    // 拒绝用旧代码打开未来版本数据库，防止静默按旧结构读写。
    if (version > 13) {
      this.raw.close();
      throw new AppError(
        "schema_version",
        "数据库版本较新，请使用相应版本的 MyAgent。",
        500,
      );
    }
    // 迁移 SQL 与 user_version 在同一事务推进；中途失败时不得留下“版本已升级但表未建完”。
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
    if (version < 2)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0002_agent.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 2");
      })();
    if (version < 3)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0003_tools.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 3");
      })();
    if (version < 4)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0004_projects.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 4");
      })();
    if (version < 5)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0005_commands.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 5");
      })();

    if (version < 6)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0006_context.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 6");
      })();
    if (version < 7)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0007_memory.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 7");
      })();
    this.memory = new SqliteMemoryStore(this.raw);
    this.context = new SqliteContextStore(this.raw, (id, event) =>
      this.emit(id, event),
    );
    if (version < 8)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0008_skills.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 8");
      })();
    if (version < 9)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0009_hooks.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 9");
      })();
    if (version < 10)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0010_plugins.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 10");
      })();
    this.plugins = new SqlitePluginStore(this.raw);
    this.hooks = new SqliteHookStore(this.raw, (id, event) =>
      this.emit(id, event),
    );
    this.skills = new SqliteSkillStore(this.raw);
    if (version < 11)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0011_teams.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 11");
      })();
    if (version < 12)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0012_observability.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 12");
      })();
    if (version < 13)
      this.raw.transaction(() => {
        this.raw.exec(
          readFileSync(
            new URL(
              "../../../../../migrations/0013_execution_mode.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.raw.pragma("user_version = 13");
      })();
    this.observations = new SqliteObservationStore(this.raw);
    this.teams = new SqliteTeamStore(this.raw, (sessionId, runId) => {
      this.emit(sessionId, { type: "team.updated", runId });
    });
    this.db = drizzle(this.raw);
    this.execution = new SqliteExecutionStore(
      this.raw,
      (id, event) => this.emit(id, event),
      (id, workspaceId, revision) => {
        this.raw.transaction(() => {
          const snapshot = this.snapshot(id);
          if (snapshot.session.revision !== revision)
            throw new AppError("revision_conflict", "会话已更新。", 409);
          if (
            snapshot.activeRun ||
            (snapshot.session.workspaceId &&
              snapshot.session.workspaceId !== workspaceId)
          )
            throw new AppError(
              "workspace_bound",
              "活动或已绑定会话不能更换工作区，请新建会话。",
              409,
            );
          this.db
            .update(tables.sessions)
            .set({ workspaceId })
            .where(eq(tables.sessions.id, id))
            .run();
          const session = this.touch(id);
          this.emit(id, { type: "session.updated", session });
        })();
      },
    );
    if (!this.db.select().from(tables.settings).get())
      this.db
        .insert(tables.settings)
        .values({
          id: 1,
          data: {
            apiProtocol: "chat_completions",
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
  // 此方法必须在状态修改事务内调用：先分配会话内 seq，再追加事件，两者一起提交。
  // 它只写事件日志，不直接向 SSE socket 推送，因此未提交的事件不会被浏览器看到。
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
      schemaVersion:
        event.type === "team.updated" ||
        (event.type === "run.updated" && event.run.status === "waiting_agents")
          ? 6
          : event.type === "hook.updated"
            ? 5
            : event.type === "context.updated" ||
                (event.type === "run.updated" &&
                  event.run.status === "waiting_context")
              ? 4
              : 3,
      sessionId: id,
      seq: row.seq,
      createdAt: new Date().toISOString(),
    };
    this.db
      .insert(tables.events)
      .values({ sessionId: id, seq: row.seq, data })
      .run();
  }
  // revision 标记命令可见的会话变更，独立于每条事件的 seq；逐字增量不会反复增加 revision。
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
    return {
      ...row.data,
      apiProtocol: row.data.apiProtocol ?? "chat_completions",
      contextWindowTokens:
        row.data.contextWindowTokens ?? CONTEXT_DEFAULTS.contextWindowTokens,
      outputReserveTokens:
        row.data.outputReserveTokens ?? CONTEXT_DEFAULTS.outputReserveTokens,
    };
  }
  // 设置也采用乐观版本检查，避免两个页面用旧 revision 相互覆盖连接配置。
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
      .filter(
        (row) =>
          !(
            this.raw
              .prepare("SELECT parent_session_id FROM sessions WHERE id=?")
              .get(row.id) as { parent_session_id: string | null }
          ).parent_session_id,
      )
      .map((row) => this.publicSession(row));
  }
  findSessionCreation(requestId: string, fingerprint: string): Session | null {
    const row = this.raw
      .prepare("SELECT * FROM session_creations WHERE request_id = ?")
      .get(requestId) as
      | { fingerprint: string; session_id: string }
      | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint)
      throw new AppError(
        "idempotency_conflict",
        "创建请求的项目目录已经变化。",
        409,
      );
    return this.publicSession(this.sessionRow(row.session_id));
  }
  createSession(input?: Parameters<ChatStore["createSession"]>[0]): Session {
    return this.raw.transaction(() => {
      if (input?.requestId) {
        const previous = this.findSessionCreation(
          input.requestId,
          input.fingerprint ?? "",
        );
        if (previous) return previous;
      }
      const now = new Date().toISOString();
      const session = {
        id: input?.id ?? randomUUID(),
        title: "新对话",
        revision: 0,
        createdAt: now,
        updatedAt: now,
        workspaceId: input?.workspace?.id ?? null,
      };
      if (input?.workspace) this.execution.put("workspaces", input.workspace);
      this.db
        .insert(tables.sessions)
        .values({ ...session, seq: 0 })
        .run();
      if (input?.parentSessionId)
        this.raw
          .prepare("UPDATE sessions SET parent_session_id=? WHERE id=?")
          .run(input.parentSessionId, session.id);
      if (input?.requestId)
        this.raw
          .prepare("INSERT INTO session_creations VALUES (?, ?, ?)")
          .run(input.requestId, input.fingerprint ?? "", session.id);
      return session;
    })();
  }
  // 历史、运行状态和 cursor 同事务读取，防止快照与补读起点不一致而漏事件或重复增量。
  // rowid 保留同毫秒写入的实际顺序，不能只靠时间戳排序。
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
        plugins: records[0]
          ? (this.plugins.get("runs", records[0].id)?.references ?? [])
          : [],
        messages,
        steps: this.db
          .select()
          .from(tables.runSteps)
          .where(eq(tables.runSteps.sessionId, id))
          .orderBy(sql`rowid`)
          .all()
          .map((item) => {
            const step = structuredClone(item.data.step);
            // v3 工具事实归 invocation；旧 Step 无 invocation 时保持原样展示。
            const invocations = this.execution.list("invocations", {
              runId: step.runId,
            });
            for (const tool of step.tools) {
              const invocation = invocations.find(
                (record) =>
                  record.stepId === step.id && record.callId === tool.id,
              );
              if (!invocation) continue;
              tool.result = invocation.result;
              tool.status =
                invocation.status === "prepared"
                  ? "pending"
                  : invocation.status === "denied"
                    ? "failed"
                    : invocation.status;
            }
            return step;
          }),
        latestRun: records[0]?.data ?? null,
        activeRun:
          records.find((item) => isActiveRun(item.status))?.data ?? null,
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
  // 取消执行由 ChatService 先完成；这里只删除会话，由外键级联清理附属记录。
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
  // 把并发检查、问题 / 候选 / Run 创建和全部开始事件放入一个同步事务。
  // 数据库还用 requestId 唯一索引和 running 部分唯一索引兜底重复提交及同会话并发。
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
      // 重新生成复用最后的问题，另建候选并记录原成功答案；此时不覆盖原内容。
      const original =
        input.kind === "regenerate"
          ? old.messages.findLast(
              (message) =>
                message.replyToId === userId && message.status === "completed",
            )
          : undefined;
      const assistant: Message = {
        origin: null,
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
        executionMode: input.executionMode ?? "standard",
        apiProtocol: input.apiProtocol ?? "chat_completions",
        stepCount: 0,
        contextTrimmed: input.contextTrimmed,
        finishReason: null,
        usage: null,
        error: null,
        createdAt: now,
        endedAt: null,
      };
      if (input.kind === "send") {
        const user: Message = {
          origin: input.origin ?? null,
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
      // 只有空会话的默认标题才用首问截取生成；不额外调用模型，也不覆盖用户手动命名。
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
  // 一次事务追加文字和 message.delta 事件；空增量不写库，结束 / 删除后的迟到回调直接忽略。
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
  /** 读取私有记录只供 Application；历史呈现使用 snapshot 中的白名单 step。 */
  getSteps(runId: string): StoredStep[] {
    return this.db
      .select()
      .from(tables.runSteps)
      .where(eq(tables.runSteps.runId, runId))
      .orderBy(tables.runSteps.stepIndex)
      .all()
      .map((row) => row.data);
  }
  saveStep(record: StoredStep): boolean {
    return this.raw.transaction(() => {
      const run = this.db
        .select()
        .from(tables.runs)
        .where(eq(tables.runs.id, record.step.runId))
        .get()?.data;
      if (!run || !isActiveRun(run.status)) return false;
      const step = record.step;
      this.db
        .insert(tables.runSteps)
        .values({
          id: step.id,
          runId: run.id,
          sessionId: run.sessionId,
          stepIndex: step.index,
          data: record,
        })
        .onConflictDoUpdate({
          target: tables.runSteps.id,
          set: { data: record },
        })
        .run();
      if ((run.stepCount ?? 0) < step.index) {
        run.stepCount = step.index;
        this.db
          .update(tables.runs)
          .set({ data: run })
          .where(eq(tables.runs.id, run.id))
          .run();
        this.emit(run.sessionId, { type: "run.updated", run });
      }
      this.emit(run.sessionId, { type: "step.updated", step });
      // 生成中的当前文字先作为候选预览；发现工具调用后移入执行过程，最终答案不混入中间说明。
      const content = step.tools.length ? "" : step.content;
      const message = this.db
        .update(tables.messages)
        .set({ content })
        .where(eq(tables.messages.id, run.assistantMessageId))
        .returning()
        .get();
      if (message)
        this.emit(run.sessionId, { type: "message.updated", message });
      return true;
    })();
  }
  appendStepDelta(runId: string, stepId: string, delta: string): boolean {
    return this.raw.transaction(() => {
      const run = this.db
        .select()
        .from(tables.runs)
        .where(eq(tables.runs.id, runId))
        .get()?.data;
      const row = this.db
        .select()
        .from(tables.runSteps)
        .where(eq(tables.runSteps.id, stepId))
        .get();
      if (
        run?.status !== "running" ||
        !row ||
        row.runId !== runId ||
        row.data.step.status !== "model"
      )
        return false;
      const data = row.data;
      data.step.content += delta;
      this.db
        .update(tables.runSteps)
        .set({ data })
        .where(eq(tables.runSteps.id, stepId))
        .run();
      this.emit(run.sessionId, { type: "step.delta", stepId, delta });
      this.appendDelta(runId, delta);
      return true;
    })();
  }
  markContextTrimmed(runId: string): void {
    this.raw.transaction(() => {
      const run = this.db
        .select()
        .from(tables.runs)
        .where(eq(tables.runs.id, runId))
        .get()?.data;
      if (run?.status !== "running" || run.contextTrimmed) return;
      run.contextTrimmed = true;
      this.db
        .update(tables.runs)
        .set({ data: run })
        .where(eq(tables.runs.id, runId))
        .run();
      this.emit(run.sessionId, { type: "run.updated", run });
    })();
  }
  // 终态只能从 running 进入一次；重复终结或迟到成功不得覆盖已有终态。
  finishRun(runId: string, outcome: FinishRun): void {
    this.raw.transaction(() => {
      const old = this.db
        .select()
        .from(tables.runs)
        .where(eq(tables.runs.id, runId))
        .get()?.data;
      if (!old || !isActiveRun(old.status)) return;
      // 进程退出可能没有来得及写 Step 终态；与 Run 在同一事务内修补，不回放动作。
      for (const record of this.getSteps(runId)) {
        if (record.step.status !== "model" && record.step.status !== "tools")
          continue;
        record.step.status =
          outcome.status === "interrupted"
            ? "interrupted"
            : outcome.status === "cancelled"
              ? "cancelled"
              : "failed";
        record.step.error = outcome.error;
        record.step.endedAt = new Date().toISOString();
        for (const tool of record.step.tools)
          if (tool.status === "pending" || tool.status === "running")
            tool.status = record.step.status;
        this.db
          .update(tables.runSteps)
          .set({ data: record })
          .where(eq(tables.runSteps.id, record.step.id))
          .run();
        this.emit(old.sessionId, { type: "step.updated", step: record.step });
      }
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
      // 成功替换原答与候选完成在同一事务内；失败或取消候选时保留原 completed 答案。
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
  // 游标是排他下界；每批最多 1000 条，Server 更新 cursor 后继续读取，避免一次拉完整日志。
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
  // 启动时仅修补数据库遗留 running 状态，保留已有文字；不读取凭证或重新请求模型。
  recoverInterrupted(): void {
    this.context.recover();
    for (const row of this.db.select().from(tables.runs).all()) {
      if (!isActiveRun(row.status)) continue;
      if (this.execution.get("checkpoints", row.id)) {
        this.raw.transaction(() => {
          this.execution.setRunStatus(row.id, "recoverable");
          for (const record of this.getSteps(row.id))
            if (
              record.step.status === "model" ||
              record.step.status === "tools"
            ) {
              record.step.status = "interrupted";
              record.step.error = {
                code: "interrupted",
                message: "本地服务重启，等待手动继续。",
              };
              record.step.endedAt = new Date().toISOString();
              this.db
                .update(tables.runSteps)
                .set({ data: record })
                .where(eq(tables.runSteps.id, record.step.id))
                .run();
              this.emit(row.sessionId, {
                type: "step.updated",
                step: record.step,
              });
            }
        })();
        continue;
      }
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
  }
  close(): void {
    this.observations.flush();
    this.raw.close();
  }
}
