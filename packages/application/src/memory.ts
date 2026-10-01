/**
 * 长期记忆应用服务：统一管理 Markdown 事实、可重建索引、人工操作与模型只读快照。
 * 文件发布有持久提交日志；后台任务和页面写入共享串行门，来源删除先撤销再清理。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  type MemoryProvider,
  type MemorySnippet,
  memoryOverviewEntries,
  redactMemoryText,
  validateMemoryEntry,
} from "@myagent/content";
import {
  AppError,
  isActiveRun,
  type MemoryEntry,
  type MemoryJobView,
  type MemoryOverview,
  type MemoryPage,
  type MemoryQuery,
  type MemoryRead,
  type MemorySettings,
  type MemorySource,
  type MemoryUpdate,
  type SessionMemorySettings,
} from "@myagent/contracts";
import type {
  ChatStore,
  ExecutionStore,
  MemoryCommit,
  MemoryFiles,
  MemoryInput,
  MemoryStore,
  MemoryTombstone,
} from "@myagent/state";
import { MemoryJobs } from "./memory-jobs.js";
import type { SettingsService } from "./settings.js";

export const memoryHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const defaults: MemorySettings = {
  revision: 0,
  enabled: false,
  useMemories: true,
  generateMemories: true,
  enabledAt: null,
  idleMinutes: 30,
  dailyRequests: 32,
  taskRequests: 8,
  requestTimeoutMs: 120000,
};
const zeroUsage = () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
export class MemoryService implements MemoryProvider {
  observer?: import("@myagent/observability").ObserverPort;
  /** 成员读取主对话的使用开关，独立会话不参与自动记忆提炼。 */
  sessionParent?: (id: string) => string | undefined;
  readonly jobs: MemoryJobs;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private lastScan = 0;
  constructor(
    readonly store: MemoryStore,
    readonly files: MemoryFiles,
    readonly chat: ChatStore,
    readonly execution: ExecutionStore,
    readonly models: SettingsService,
    readonly now: () => number = Date.now,
  ) {
    this.jobs = new MemoryJobs(this);
  }
  timestamp(): string {
    return new Date(this.now()).toISOString();
  }
  /** 此门只保护状态准备/发布，绝不持锁等待模型网络。 */
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.catch(() => {}).then(operation);
    this.tail = task;
    return task;
  }
  settings(): MemorySettings {
    const { id: _, ...value } = this.store.get("settings", "global") ?? {
      id: "global",
      ...defaults,
    };
    return value;
  }
  sessionSettings(id: string): SessionMemorySettings {
    this.chat.snapshot(id);
    const parent = this.sessionParent?.(id);
    if (parent)
      return { ...this.sessionSettings(parent), id, contributeMemories: false };
    return (
      this.store.get("sessions", id) ?? {
        id,
        revision: 0,
        useMemories: true,
        contributeMemories: true,
      }
    );
  }
  saveSession(
    id: string,
    input: Omit<SessionMemorySettings, "id" | "revision"> & {
      expectedRevision: number;
    },
  ): SessionMemorySettings {
    const old = this.sessionSettings(id);
    if (old.revision !== input.expectedRevision)
      throw new AppError("revision_conflict", "会话记忆设置已变化。", 409);
    const next = {
      id,
      revision: old.revision + 1,
      useMemories: input.useMemories,
      contributeMemories: input.contributeMemories,
    };
    this.store.put("sessions", next);
    if (!next.contributeMemories) this.jobs.cancelSession(id);
    return next;
  }
  saveSettings(
    input: Omit<MemorySettings, "revision" | "enabledAt"> & {
      expectedRevision: number;
    },
  ): MemorySettings {
    const old = this.settings();
    if (old.revision !== input.expectedRevision)
      throw new AppError("revision_conflict", "记忆设置已变化。", 409);
    for (const [value, min, max] of [
      [input.idleMinutes, 0, 10080],
      [input.dailyRequests, 1, 10000],
      [input.taskRequests, 2, 1000],
      [input.requestTimeoutMs, 100, 600000],
    ])
      if (!Number.isSafeInteger(value) || value! < min! || value! > max!)
        throw new AppError("invalid_input", "记忆预算或时间设置无效。");
    const { expectedRevision: _, ...fields } = input;
    const next = {
      ...fields,
      revision: old.revision + 1,
      enabledAt: old.enabledAt ?? (input.enabled ? this.timestamp() : null),
    };
    this.store.put("settings", { id: "global", ...next });
    if (!next.enabled) this.jobs.cancelAll();
    else if (!next.generateMemories) this.jobs.cancelAll(true);
    return next;
  }
  async initialize(): Promise<void> {
    for (const job of this.store.list("jobs"))
      if (["running", "yielded"].includes(job.status)) {
        job.status = "interrupted";
        job.updatedAt = this.timestamp();
        job.error = {
          code: "interrupted",
          message: "服务重启，请明确重试整理。",
        };
        for (const call of job.callRecords) {
          if (call.status !== "running") continue;
          call.status = "interrupted";
          job.usage = null;
          const day = this.store.get("usage", call.startedAt.slice(0, 10));
          if (day) this.store.put("usage", { ...day, usage: null });
        }
        this.store.put("jobs", job);
      }
    await this.refresh();
  }
  entries(): MemoryEntry[] {
    return this.store.list("entries");
  }
  revision(): string {
    return this.store.get("meta", "global")?.revision ?? this.files.hash("");
  }
  private summary(entries: MemoryEntry[]): string {
    return memoryOverviewEntries(entries, null, 2500)
      .map((e) => e.text)
      .join("\n\n");
  }
  /** 所有读者先恢复提交日志；文件落盘后崩溃也不会再次调用模型。 */
  async refresh(): Promise<void> {
    return this.serial(() => this.refreshInside());
  }
  private async refreshInside(): Promise<void> {
    try {
      for (const commit of this.store.list("commits"))
        await this.finishCommit(commit);
      const document = await this.files.read();
      const oldMeta = this.store.get("meta", "global");
      if (document.revision === oldMeta?.revision && !oldMeta.error) return;
      const old = this.entries();
      if (!oldMeta) {
        // 从文件重建索引，不覆盖文件；元数据仍需严格格式校验。
        this.index(
          document.entries,
          document.revision,
          this.summary(document.entries),
        );
        await this.files.derived(this.summary(document.entries));
        return;
      }
      const now = this.timestamp();
      const normalized = document.entries.map((entry) => {
        const previous = old.find((e) => e.id === entry.id);
        const text = redactMemoryText(entry.text);
        if (previous && memoryHash({ ...entry, text }) === memoryHash(previous))
          return previous;
        // 外部正文修改是人工版本；不能伪造旧来源、清掉人工保护或降低版本。
        return {
          ...entry,
          text,
          title: redactMemoryText(entry.title),
          sources: previous?.sources ?? [],
          manual: true,
          revision: (previous?.revision ?? 0) + 1,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
      });
      const removed = old.filter((e) => !normalized.some((n) => n.id === e.id));
      await this.publishInside(
        normalized,
        document.revision,
        "外部文件编辑",
        removed.length ? [this.tombstone(removed)] : [],
        null,
        null,
        old,
      );
    } catch (error) {
      const safe =
        error instanceof AppError
          ? { code: error.code, message: error.message }
          : {
              code: "memory_io",
              message: "记忆文件同步失败，请检查文件并重试。",
            };
      this.store.put("meta", {
        id: "global",
        revision: this.revision(),
        summary: "",
        error: safe,
      });
    }
  }
  private index(
    entries: MemoryEntry[],
    revision: string,
    summary: string,
  ): void {
    this.store.transaction(() => {
      for (const old of this.entries()) this.store.remove("entries", old.id);
      for (const entry of entries) this.store.put("entries", entry);
      this.store.put("meta", { id: "global", revision, summary, error: null });
    });
  }
  private async finishCommit(commit: MemoryCommit): Promise<void> {
    const current = await this.files.read();
    const target = this.files.hash(commit.text);
    const invalid = () => {
      if (!commit.jobId) return false;
      const job = this.store.get("jobs", commit.jobId);
      return (
        !job ||
        ["cancelled", "stale"].includes(job.status) ||
        !this.jobs.sourcesCurrent(job)
      );
    };
    const rollback = async () => {
      const actual = await this.files.read();
      if (actual.revision === target)
        await this.files.write(commit.previousText, target);
      else if (actual.revision !== commit.expectedRevision)
        throw new AppError(
          "memory_commit_conflict",
          "取消发布时发现外部修改，已停止覆盖文件。",
          409,
        );
      await this.files.derived(this.summary(this.entries()));
      this.store.remove("commits", commit.id);
    };
    if (invalid()) {
      await rollback();
      throw new AppError("memory_stale", "整理来源已撤销，发布已取消。", 409);
    }
    if (current.revision !== target) {
      if (current.revision !== commit.expectedRevision)
        throw new AppError(
          "memory_commit_conflict",
          "上次记忆发布未完成且文件发生外部变化，请恢复文件后重试同步。",
          409,
        );
      await this.files.write(commit.text, current.revision);
    }
    await this.files.derived(commit.summary, commit.rollout ?? undefined);
    if (invalid()) {
      await rollback();
      throw new AppError(
        "memory_stale",
        "整理期间来源已变化，未启用候选。",
        409,
      );
    }
    this.store.transaction(() => {
      this.index(commit.entries, target, commit.summary);
      this.store.put("changes", commit.change);
      for (const tombstone of commit.tombstones)
        this.store.put("tombstones", tombstone);
      if (commit.operation) this.store.put("operations", commit.operation);
      if (commit.jobId) {
        const job = this.store.get("jobs", commit.jobId);
        if (job)
          this.store.put("jobs", {
            ...job,
            status: "completed",
            error: null,
            input: [],
            chunks: [],
            draft: [],
            updatedAt: this.timestamp(),
          });
      }
      this.store.remove("commits", commit.id);
    });
  }
  /** 调用者持有串行门；先写意图，落盘后最后切换索引。旧文件不能在恢复时丢失引用。 */
  private async publishInside(
    entries: MemoryEntry[],
    expectedRevision: string,
    reason: string,
    tombstones: MemoryTombstone[] = [],
    operation: MemoryCommit["operation"] = null,
    rollout: MemoryCommit["rollout"] = null,
    before = this.entries(),
    jobId: string | null = null,
  ): Promise<void> {
    const text = this.files.render(entries);
    const id = randomUUID();
    const changed = (a: MemoryEntry[], b: MemoryEntry[]) =>
      a.filter(
        (e) =>
          !b.some(
            (other) => other.id === e.id && memoryHash(other) === memoryHash(e),
          ),
      );
    const previousText = (await this.files.read()).text;
    if (this.files.hash(previousText) !== expectedRevision)
      throw new AppError("revision_conflict", "记忆发布前文件已变化。", 409);
    const commit: MemoryCommit = {
      id,
      expectedRevision,
      text,
      entries,
      summary: this.summary(entries),
      tombstones,
      operation,
      rollout,
      jobId,
      previousText,
      change: {
        id,
        createdAt: this.timestamp(),
        reason,
        before: changed(before, entries),
        after: changed(entries, before),
        undoable: !reason.startsWith("删除会话"),
      },
    };
    this.store.put("commits", commit);
    try {
      await this.finishCommit(commit);
    } catch (error) {
      // 未落盘失败（例如容量上限）不能永久阻塞后续修复；确认仍是旧正文才撤销意图。
      // 已 rename 或无法确定文件状态时保留日志，恢复不得丢失已落盘版本。
      const actual = await this.files.read().catch(() => null);
      if (
        (error instanceof AppError && error.code === "revision_conflict") ||
        (actual?.revision === expectedRevision &&
          expectedRevision !== this.files.hash(text))
      )
        this.store.remove("commits", id);
      throw error;
    }
  }
  async publishJob(
    jobId: string,
    entries: MemoryEntry[],
    expectedRevision: string,
    rollout: string,
  ): Promise<void> {
    await this.serial(async () => {
      await this.refreshInside();
      this.assertHealthy();
      const job = this.store.get("jobs", jobId);
      if (
        !job ||
        !["running", "yielded"].includes(job.status) ||
        !this.jobs.sourcesCurrent(job) ||
        this.revision() !== expectedRevision
      )
        throw new AppError(
          "memory_stale",
          "来源或记忆版本发生变化，本次候选未发布。",
          409,
        );
      await this.publishInside(
        entries,
        expectedRevision,
        "后台整理",
        [],
        null,
        { id: `${job.sessionId}_${job.id}`, text: rollout },
        this.entries(),
        jobId,
      );
    });
  }
  private assertHealthy(): void {
    const error = this.store.get("meta", "global")?.error;
    if (error) throw new AppError(error.code, error.message, 409);
  }
  private tombstone(
    entries: MemoryEntry[],
    sessionId: string | null = null,
  ): MemoryTombstone {
    return {
      id: randomUUID(),
      sourceIds: entries.flatMap((e) => e.sources.map((s) => s.id)),
      entryIds: entries.map((e) => e.id),
      sessionId,
      createdAt: this.timestamp(),
    };
  }
  blockedSource(id: string): boolean {
    return this.store.list("tombstones").some((t) => t.sourceIds.includes(id));
  }
  blockedSession(id: string): boolean {
    return this.store.list("tombstones").some((t) => t.sessionId === id);
  }
  private allowedEntry(entry: MemoryEntry): boolean {
    return (
      entry.status === "active" &&
      !entry.sources.some((s) => this.blockedSession(s.sessionId))
    );
  }
  async update(
    input: MemoryUpdate,
    origin?: { sessionId: string; runId: string; invocationId: string },
    signal?: AbortSignal,
  ): Promise<MemoryEntry | null> {
    const fingerprint = memoryHash(input);
    return this.serial(async () => {
      signal?.throwIfAborted();
      const prior = this.store.get("operations", input.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new AppError(
            "idempotency_conflict",
            "记忆请求标识已用于其他操作。",
            409,
          );
        return prior.result;
      }
      await this.refreshInside();
      this.assertHealthy();
      if (origin) {
        if (!this.settings().enabled)
          throw new AppError("memory_disabled", "长期记忆尚未开启。");
        const run = this.chat.getRun(origin.runId);
        if (run.sessionId !== origin.sessionId || !isActiveRun(run.status))
          throw new AppError("interrupted", "运行已结束，记忆未修改。", 409);
      }
      const all = this.entries();
      if (
        input.action === "add" &&
        (input.id !== undefined || input.expectedRevision !== undefined)
      )
        throw new AppError(
          "invalid_input",
          "新增记忆不能指定已有条目或版本，请使用带版本的更正操作。",
        );
      const old = all.find((e) => e.id === input.id);
      if (
        input.action !== "add" &&
        (!old || old.revision !== input.expectedRevision)
      )
        throw new AppError(
          "revision_conflict",
          "记忆不存在或版本已改变，请先查阅。",
          409,
        );
      let result: MemoryEntry | null = null;
      const now = this.timestamp();
      if (input.action !== "forget") {
        result = {
          id: old?.id ?? randomUUID(),
          title: redactMemoryText(input.title ?? old?.title ?? ""),
          text: redactMemoryText(input.text ?? old?.text ?? ""),
          kind: input.kind ?? old?.kind ?? "experience",
          project:
            input.project === undefined
              ? (old?.project ?? null)
              : input.project,
          revision: (old?.revision ?? 0) + 1,
          manual: true,
          status: "active",
          sources: old?.sources ?? [],
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
        };
        // 明确保存的新记忆为独立人工条目；用户请求的出处留在调用记录，不把删除聊天等同删除独立笔记。
        validateMemoryEntry(result);
      }
      signal?.throwIfAborted();
      const next = all.filter((e) => e.id !== old?.id);
      if (result) next.push(result);
      const operation = { id: input.requestId, fingerprint, result };
      await this.publishInside(
        next,
        this.revision(),
        `${origin ? "对话" : "页面"}${input.action === "add" ? "新增" : input.action === "edit" ? "更正" : "遗忘"}`,
        old ? [this.tombstone([old])] : [],
        operation,
      );
      return result;
    });
  }
  async undo(
    changeId: string,
    expectedRevision: string,
    requestId: string,
  ): Promise<void> {
    await this.serial(async () => {
      const fingerprint = memoryHash([changeId, expectedRevision]);
      const previous = this.store.get("operations", requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new AppError(
            "idempotency_conflict",
            "撤销标识已用于其他操作。",
            409,
          );
        return;
      }
      await this.refreshInside();
      this.assertHealthy();
      const change = this.store.get("changes", changeId);
      if (
        !change?.undoable ||
        expectedRevision !== this.revision() ||
        this.store.list("changes").at(-1)?.id !== changeId
      )
        throw new AppError(
          "revision_conflict",
          "只可撤销当前最新有效变更，请先刷新。",
          409,
        );
      if (
        change.before.some((e) =>
          e.sources.some((s) => this.blockedSession(s.sessionId)),
        )
      )
        throw new AppError(
          "memory_source_removed",
          "不能恢复来源已删除的记忆。",
        );
      const affected = new Set(
        [...change.before, ...change.after].map((e) => e.id),
      );
      const next = [
        ...this.entries().filter((e) => !affected.has(e.id)),
        ...change.before.map((e) => ({
          ...e,
          manual: true,
          revision:
            Math.max(
              e.revision,
              this.entries().find((v) => v.id === e.id)?.revision ?? 0,
            ) + 1,
          updatedAt: this.timestamp(),
        })),
      ];
      await this.publishInside(next, this.revision(), "用户撤销变更", [], {
        id: requestId,
        fingerprint,
        result: null,
      });
    });
  }
  /** 撤销来源先落墓碑，让在途任务与读取立即失效；随后文件清理可重复恢复。 */
  async deleteSession(id: string): Promise<void> {
    this.jobs.cancelSession(id);
    await this.serial(async () => {
      await this.refreshInside();
      this.assertHealthy();
      const all = this.entries();
      const affected = all.filter((e) =>
        e.sources.some((s) => s.sessionId === id),
      );
      const tombstone = this.tombstone(affected, id);
      tombstone.sourceIds = affected.flatMap((e) =>
        e.sources.filter((s) => s.sessionId === id).map((s) => s.id),
      );
      this.store.put("tombstones", tombstone);
      const next = all.flatMap((e) => {
        if (!affected.includes(e)) return [e];
        const sources = e.sources.filter((s) => s.sessionId !== id);
        // 混合来源的旧正文不再提供；保留余下来源待手动/空闲重新提炼，不能猜测哪半句仍正确。
        return sources.length
          ? [
              {
                ...e,
                sources,
                status: "needs_review" as const,
                revision: e.revision + 1,
                updatedAt: this.timestamp(),
              },
            ]
          : [];
      });
      await this.publishInside(next, this.revision(), "删除会话贡献", [
        tombstone,
      ]);
      for (const sourceSession of new Set(
        affected.flatMap((e) =>
          e.sources.filter((s) => s.sessionId !== id).map((s) => s.sessionId),
        ),
      )) {
        this.store.put("rebuild", {
          id: sourceSession,
          createdAt: this.timestamp(),
        });
        for (const job of this.store.list("jobs"))
          if (job.sessionId === sourceSession && job.status === "completed")
            this.store.put("jobs", { ...job, status: "stale" });
      }
      await this.files.removeRollouts(id);
      for (const job of this.store.list("jobs"))
        if (job.sessionId === id) this.store.remove("jobs", job.id);
      for (const change of this.store.list("changes"))
        if (
          [...change.before, ...change.after].some((e) =>
            e.sources.some((s) => s.sessionId === id),
          )
        )
          this.store.remove("changes", change.id);
      this.store.remove("sessions", id);
    });
  }
  private checkRead(sessionId?: string): void {
    this.assertHealthy();
    const settings = this.settings();
    if (
      sessionId &&
      (!settings.enabled ||
        !settings.useMemories ||
        !this.sessionSettings(sessionId).useMemories)
    )
      throw new AppError("memory_disabled", "当前会话已关闭记忆读取。");
  }
  private cursor(
    value: string | undefined,
    key: string,
  ): { page: number; offset: number } {
    if (!value) return { page: 0, offset: 0 };
    try {
      const v = JSON.parse(Buffer.from(value, "base64url").toString());
      if (
        v.key !== key ||
        !Number.isSafeInteger(v.page) ||
        v.page < 0 ||
        !Number.isSafeInteger(v.offset) ||
        v.offset < 0
      )
        throw Error();
      return v;
    } catch {
      throw new AppError(
        "invalid_cursor",
        "记忆游标或版本已失效，请重新查阅。",
      );
    }
  }
  private next(key: string, page: number, offset = 0): string {
    return Buffer.from(JSON.stringify({ key, page, offset })).toString(
      "base64url",
    );
  }
  async search(
    query: MemoryQuery = {},
    sessionId?: string,
  ): Promise<MemoryPage> {
    await this.refresh();
    this.checkRead(sessionId);
    const revision = this.revision();
    const key = memoryHash([
      revision,
      query.query,
      query.project,
      query.kind,
      sessionId,
    ]);
    const { page } = this.cursor(query.cursor, key);
    const terms = (query.query ?? "")
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const project = sessionId ? this.project(sessionId) : null;
    const rank = (e: MemoryEntry) =>
      terms.reduce(
        (sum, t) => sum + (e.title.toLocaleLowerCase().includes(t) ? 4 : 1),
        0,
      ) +
      (project && e.project === project ? 3 : 0) +
      (e.manual ? 1 : 0);
    const all = this.entries()
      .filter(
        (e) =>
          (sessionId
            ? this.allowedEntry(e)
            : !e.sources.some((s) => this.blockedSession(s.sessionId))) &&
          (!query.project || e.project === query.project) &&
          (!query.kind || e.kind === query.kind) &&
          terms.every((t) =>
            `${e.title} ${e.text}`.toLocaleLowerCase().includes(t),
          ),
      )
      .sort(
        (a, b) =>
          rank(b) - rank(a) ||
          (this.store.get("access", b.id)?.at ?? b.updatedAt).localeCompare(
            this.store.get("access", a.id)?.at ?? a.updatedAt,
          ) ||
          a.id.localeCompare(b.id),
      );
    const entries: MemoryEntry[] = [];
    let i = page;
    const limit = Math.min(20, Math.max(1, query.limit ?? 20));
    for (; i < all.length && entries.length < limit; i++) {
      const e = all[i]!;
      const preview = {
        ...e,
        text: e.text.slice(0, 350),
        sources: e.sources.slice(0, 3),
      };
      if (
        JSON.stringify({
          entries: [...entries, preview],
          revision,
          nextCursor: this.next(key, i + 1),
        }).length > 8000
      )
        break;
      entries.push(preview);
    }
    return {
      entries,
      revision,
      nextCursor: i < all.length ? this.next(key, i) : null,
    };
  }
  async readEntry(
    id: string,
    cursor?: string,
    sourceId?: string,
    sessionId?: string,
  ): Promise<MemoryRead> {
    await this.refresh();
    this.checkRead(sessionId);
    const entry = this.entries().find(
      (e) =>
        e.id === id &&
        (sessionId
          ? this.allowedEntry(e)
          : !e.sources.some((s) => this.blockedSession(s.sessionId))),
    );
    if (!entry) throw new AppError("not_found", "记忆不存在或已撤销。", 404);
    const extractions = this.store
      .list("jobs")
      .filter(
        (j) =>
          j.status === "completed" &&
          j.candidates.some((c) =>
            c.sources.some((s) => entry.sources.some((e) => e.id === s.id)),
          ),
      );
    const extraction = sourceId?.startsWith("extraction:")
      ? extractions.find((j) => `extraction:${j.id}` === sourceId)
      : null;
    const source = sourceId
      ? entry.sources.find((s) => s.id === sourceId)
      : null;
    if (sourceId && !source && !extraction)
      throw new AppError("memory_source", "来源不属于这条记忆。", 403);
    let text = entry.text;
    if (extraction) {
      // 仅提供与该条目关联的提炼产物，绝不返回连接快照、原始模型输入或其他会话路径。
      text = extraction.candidates
        .filter((c) =>
          c.sources.some((s) => entry.sources.some((e) => e.id === s.id)),
        )
        .map(
          (c) =>
            `## ${c.title}\n${c.text}\n来源：${c.sources.map((s) => s.id).join(", ")}`,
        )
        .join("\n\n");
      text = `提炼时间：${extraction.updatedAt}\n${text}`;
    } else if (source) {
      const record = this.sourceRecords(source.sessionId, undefined, true).find(
        (r) => r.source.id === source.id,
      );
      if (!record || this.blockedSession(source.sessionId))
        throw new AppError(
          "memory_source_removed",
          "原始来源已变化、撤销或不可查。",
          404,
        );
      text = record.text;
    }
    const key = memoryHash([id, entry.revision, sourceId ?? null, sessionId]);
    const { offset, page } = this.cursor(cursor, key);
    if (offset > text.length)
      throw new AppError("invalid_cursor", "记忆读取位置无效。");
    const { text: _, ...meta } = entry;
    const data = {
      entry: {
        ...meta,
        sources: source
          ? [source]
          : sourceId
            ? []
            : meta.sources.slice(page * 8, (page + 1) * 8),
      },
      text: "",
      nextCursor: null as string | null,
      source: source ?? null,
      extractions: sourceId
        ? []
        : extractions
            .slice(
              Math.max(0, page * 8 - meta.sources.length),
              Math.max(0, (page + 1) * 8 - meta.sources.length),
            )
            .map((j) => ({ id: `extraction:${j.id}`, createdAt: j.updatedAt })),
    };
    // 最终 JSON 包装、来源和游标同样计入 8000 字符；不会只限制正文。
    let end = Math.min(text.length, offset + 6000);
    do {
      data.text = text.slice(offset, end);
      data.nextCursor =
        end < text.length
          ? this.next(key, 0, end)
          : !sourceId &&
              (page + 1) * 8 < meta.sources.length + extractions.length
            ? this.next(key, page + 1, end)
            : null;
      if (JSON.stringify(data).length <= 8000) break;
      end--;
    } while (end > offset);
    if (JSON.stringify(data).length > 8000)
      throw new AppError("memory_limit", "来源元数据过大，请通过页面查阅。");
    this.store.put("access", {
      id,
      count: (this.store.get("access", id)?.count ?? 0) + 1,
      at: this.timestamp(),
    });
    return data;
  }
  project(sessionId: string): string | null {
    const id = this.chat.snapshot(sessionId).session.workspaceId;
    const workspace = id ? this.execution.get("workspaces", id) : null;
    return workspace?.kind === "project" || (workspace && !workspace.kind)
      ? workspace.path
      : null;
  }
  async read(
    input: {
      sessionId: string;
      workspaceId: string | null;
      query: string;
      budget: number;
    },
    _signal: AbortSignal,
  ): Promise<readonly MemorySnippet[]> {
    await this.refresh();
    const settings = this.settings();
    if (
      !settings.enabled ||
      !settings.useMemories ||
      !this.sessionSettings(input.sessionId).useMemories ||
      this.store.get("meta", "global")?.error
    )
      return [];
    const project = this.project(input.sessionId);
    const budget = Math.min(2500, input.budget);
    return memoryOverviewEntries(
      this.entries().filter((e) => this.allowedEntry(e)),
      project,
      Math.max(0, budget - 100),
    ).map(({ entry, text }) => ({
      sourceId: entry.id,
      version: String(entry.revision),
      scope: entry.project ?? "global",
      text,
    }));
  }
  async validate(
    sessionId: string,
    pieces: readonly MemorySnippet[],
  ): Promise<readonly MemorySnippet[]> {
    await this.refresh();
    const settings = this.settings();
    if (
      !settings.enabled ||
      !settings.useMemories ||
      !this.sessionSettings(sessionId).useMemories ||
      this.store.get("meta", "global")?.error
    )
      return [];
    const revoked = new Set(
      this.store.list("tombstones").flatMap((t) => t.entryIds),
    );
    return pieces.filter((p) => {
      const e = this.store.get("entries", p.sourceId);
      return (
        e &&
        (sessionId
          ? this.allowedEntry(e)
          : !e.sources.some((s) => this.blockedSession(s.sessionId))) &&
        (!revoked.has(e.id) || p.version === String(e.revision))
      );
    });
  }
  /** 只读白名单投影；不复制厂商续接、工具二进制或任意磁盘文件。提炼源按完整记录重组。 */
  sourceRecords(
    sessionId: string,
    since?: string,
    includeExcluded = false,
  ): MemoryInput[] {
    if (this.blockedSession(sessionId)) return [];
    const snapshot = this.chat.snapshot(sessionId);
    const result: MemoryInput[] = [];
    let cursor: string | undefined;
    const assembled = new Map<
      string,
      { text: string; source: MemorySource; runId: string; kind: string }
    >();
    let pages = 0;
    do {
      const page = this.executionHistory(sessionId, cursor);
      for (const e of page.entries) {
        if (e.answerStatus === "superseded" || e.status === "superseded")
          continue;
        const run = this.chat.getRun(e.runId);
        if (isActiveRun(run.status) || (since && run.createdAt < since))
          continue;
        const old = assembled.get(e.sourceId);
        const message = snapshot.messages.find((m) => m.id === e.sourceId);
        const createdAt = message?.createdAt ?? run.createdAt;
        assembled.set(e.sourceId, {
          text: (old?.text ?? "") + e.text,
          kind: e.kind,
          runId: e.runId,
          source: {
            id: "",
            sessionId,
            recordId: e.sourceId,
            hash: "",
            createdAt,
            status: e.answerStatus ?? e.status,
          },
        });
      }
      cursor = page.nextCursor ?? undefined;
      if (++pages > 2000)
        throw new AppError(
          "memory_input_limit",
          "会话过大，请先在页面选取较小的来源范围。",
        );
    } while (cursor);
    const runsWithSteps = new Set(
      [...assembled.values()]
        .filter((r) => r.kind === "step")
        .map((r) => r.runId),
    );
    const ordered = [...assembled.values()].sort((a, b) => {
      const time =
        Date.parse(a.source.createdAt) - Date.parse(b.source.createdAt);
      if (time) return time;
      const rank = (kind: string) =>
        kind === "user"
          ? 0
          : kind === "step"
            ? 1
            : kind === "assistant"
              ? 2
              : 3;
      if (a.kind !== b.kind) return rank(a.kind) - rank(b.kind);
      if (a.kind === "step" && a.runId === b.runId) {
        const steps = this.chat.getSteps(a.runId).map((s) => s.step.id);
        return (
          steps.indexOf(a.source.recordId) - steps.indexOf(b.source.recordId)
        );
      }
      return a.source.recordId.localeCompare(b.source.recordId);
    });
    for (const record of ordered) {
      if (
        record.kind === "invocation" ||
        (record.kind === "assistant" && runsWithSteps.has(record.runId))
      )
        continue;
      const text = redactMemoryText(record.text);
      const hash = memoryHash(text);
      const source = {
        ...record.source,
        hash,
        id: memoryHash([sessionId, record.source.recordId, hash]),
      };
      if (includeExcluded || !this.blockedSource(source.id))
        result.push({ source, text });
    }
    return result;
  }
  // ContextStore 单独注入，保持 ChatStore 公开契约不感知具体 SQLite 实现。
  historyReader!: (
    sessionId: string,
    cursor?: string,
  ) => import("@myagent/contracts").HistoryPage;
  private executionHistory(sessionId: string, cursor?: string) {
    return this.historyReader(sessionId, cursor);
  }
  async overview(): Promise<MemoryOverview> {
    await this.refresh();
    const meta = this.store.get("meta", "global");
    const usage = this.store
      .list("usage")
      .reduce<ReturnType<typeof zeroUsage> | null>(
        (a, b) =>
          a && b.usage
            ? {
                inputTokens: a.inputTokens + b.usage.inputTokens,
                outputTokens: a.outputTokens + b.usage.outputTokens,
                totalTokens: a.totalTokens + b.usage.totalTokens,
              }
            : null,
        zeroUsage(),
      );
    return {
      settings: this.settings(),
      revision: this.revision(),
      summary: meta?.summary ?? "",
      entryCount: this.entries().filter((e) => this.allowedEntry(e)).length,
      paths: this.files.paths,
      jobs: this.store
        .list("jobs")
        .toReversed()
        .slice(0, 100)
        .map((job) => this.jobView(job)),
      changes: this.store.list("changes").toReversed().slice(0, 50),
      todayRequests:
        this.store.get("usage", this.timestamp().slice(0, 10))?.requests ?? 0,
      usage,
      error: meta?.error ?? null,
    };
  }
  jobView(job: MemoryJobView): MemoryJobView {
    const {
      id,
      sessionId,
      status,
      phase,
      manual,
      requests,
      usage,
      model,
      apiProtocol,
      createdAt,
      updatedAt,
      error,
    } = job;
    return {
      id,
      sessionId,
      status,
      phase,
      manual,
      requests,
      usage,
      model,
      apiProtocol,
      createdAt,
      updatedAt,
      error,
    };
  }
  async maintain(force = false): Promise<void> {
    if (this.closing) return;
    await this.refresh();
    if (force || this.now() - this.lastScan >= 60000) {
      this.lastScan = this.now();
      await this.jobs.scan();
    }
    this.jobs.kick();
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.jobs.close();
    await this.tail.catch(() => {});
  }
}
