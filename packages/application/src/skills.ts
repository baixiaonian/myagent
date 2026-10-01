/**
 * Skill 应用服务：管理来源、冻结目录、生成激活候选与每次请求的独立指令块。
 * 工具加载先暂存候选，只有工具回执事务提交时才激活；显式选择在第一次模型请求前完成。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type ActiveSkill,
  AppError,
  isActiveRun,
  type SkillCatalog,
  type SkillContextView,
  type SkillEntry,
  type SkillPage,
  type SkillSource,
  type SkillSourceInput,
  type ToolInvocation,
  type ToolResult,
  type Workspace,
} from "@myagent/contracts";
import {
  explicitSkills,
  type SkillFilesPort,
  type SkillPackage,
} from "@myagent/extensions";
import {
  abortable,
  type ExecutionContext,
  estimateTokens,
  type ModelMessage,
} from "@myagent/kernel";
import type {
  ChatStore,
  ExecutionStore,
  SkillRun,
  SkillStore,
} from "@myagent/state";
export class SkillService {
  observer?: import("@myagent/observability").ObserverPort;
  pluginSources?: (workspaceId?: string, runId?: string) => SkillSource[];
  private readonly pending = new Map<
    string,
    { runId: string; entry: SkillEntry; pkg: SkillPackage }
  >();
  constructor(
    readonly store: SkillStore,
    readonly files: SkillFilesPort,
    private readonly chat: ChatStore,
    private readonly execution: ExecutionStore,
    readonly userRoot: string,
  ) {}
  private workspace(id?: string): Workspace | null {
    if (!id) return null;
    const workspace = this.execution.get("workspaces", id);
    if (!workspace) throw new AppError("not_found", "项目不存在。", 404);
    return workspace;
  }
  catalog(workspaceId?: string, fresh = true, runId?: string): SkillCatalog {
    const workspace = this.workspace(workspaceId);
    const sources: SkillSource[] = [
      {
        id: "user-default",
        path: this.userRoot,
        scope: "user",
        workspaceId: null,
        enabled: true,
        builtin: true,
        revision: 0,
      },
    ];
    if (workspace)
      sources.push({
        id: `project-${workspace.id}`,
        path: join(workspace.path, ".myagent/skills"),
        scope: "project",
        workspaceId: workspace.id,
        enabled: true,
        builtin: true,
        revision: 0,
      });
    sources.push(
      ...this.store
        .list("sources")
        .filter((s) => s.scope === "user" || s.workspaceId === workspaceId),
    );
    sources.push(...(this.pluginSources?.(workspaceId, runId) ?? []));
    const entries = sources
      .flatMap((source) => this.files.scan(source, fresh))
      .map((entry) => ({
        ...entry,
        ...(sources.find((s) => s.id === entry.sourceId)?.plugin
          ? { plugin: sources.find((s) => s.id === entry.sourceId)!.plugin! }
          : {}),
        enabled:
          entry.enabled &&
          (this.store.get("enabled", entry.id)?.enabled ?? true),
      }));
    return { sources, entries };
  }
  addSource(input: SkillSourceInput): SkillSource {
    const workspace =
      input.scope === "project" ? this.workspace(input.workspaceId) : null;
    if (input.scope === "project" && !workspace)
      throw new AppError("invalid_input", "项目级来源需要选择项目。");
    const path = this.files.validateSource(input.path);
    const existing = this.store
      .list("sources")
      .find(
        (s) => s.path === path && s.workspaceId === (workspace?.id ?? null),
      );
    if (existing) return existing;
    const source: SkillSource = {
      id: randomUUID(),
      path,
      scope: input.scope,
      workspaceId: workspace?.id ?? null,
      enabled: true,
      builtin: false,
      revision: 0,
    };
    this.store.put("sources", source);
    return source;
  }
  changeSource(
    id: string,
    input: {
      enabled?: boolean;
      scope?: "user" | "project";
      workspaceId?: string;
      expectedRevision: number;
    },
  ): SkillSource {
    const old = this.store.get("sources", id);
    if (!old) throw new AppError("not_found", "来源不存在。", 404);
    if (old.revision !== input.expectedRevision)
      throw new AppError("revision_conflict", "来源已变更，请刷新。", 409);
    const scope = input.scope ?? old.scope;
    const workspace =
      scope === "project"
        ? this.workspace(input.workspaceId ?? old.workspaceId ?? undefined)
        : null;
    if (scope === "project" && !workspace)
      throw new AppError("invalid_input", "项目级来源需要选择项目。");
    const source = {
      ...old,
      scope,
      workspaceId: workspace?.id ?? null,
      enabled: input.enabled ?? old.enabled,
      revision: old.revision + 1,
    };
    this.store.put("sources", source);
    return source;
  }
  removeSource(id: string): void {
    this.store.delete("sources", id);
  }
  setEnabled(id: string, enabled: boolean, workspaceId?: string): void {
    if (this.entry(id, workspaceId).plugin)
      throw new AppError("plugin_managed", "请在插件管理中修改组件状态。", 409);
    this.store.put("enabled", { id, enabled });
  }
  private entry(id: string, workspaceId?: string): SkillEntry {
    const entry = this.catalog(workspaceId).entries.find((e) => e.id === id);
    if (!entry)
      throw new AppError("skill_unavailable", "技能不属于当前可用来源。", 404);
    return entry;
  }
  detail(id: string, workspaceId?: string) {
    const entry = this.entry(id, workspaceId);
    return {
      entry,
      body: entry.error ? "" : this.files.detail(entry),
      resources: entry.error ? [] : this.files.resources(entry),
    };
  }
  /** 与创建 Run 同事务，只保存目录和显式选择；没有任何模型或脚本调用。 */
  initialize(
    runId: string,
    question: string,
    selected?: string[],
    originalQuestionId?: string,
  ): void {
    const run = this.chat.getRun(runId),
      session = this.chat.snapshot(run.sessionId).session;
    const entries = this.catalog(
      session.workspaceId ?? undefined,
      true,
      runId,
    ).entries;
    const inherited = originalQuestionId
      ? this.store
          .list("runs")
          .find(
            (r) =>
              r.sessionId === run.sessionId &&
              r.questionId === originalQuestionId &&
              this.chat.getRun(r.id).kind === "send",
          )?.selected
      : undefined;
    const ids = explicitSkills(question, entries, selected ?? inherited ?? []);
    this.store.put("runs", {
      id: runId,
      sessionId: run.sessionId,
      questionId: run.userMessageId,
      entries,
      selected: ids,
      active: [],
    });
  }
  private state(runId: string): SkillRun {
    const record = this.store.get("runs", runId);
    if (!record)
      throw new AppError("skill_unavailable", "本轮没有技能目录。", 409);
    return record;
  }
  private assertActive(runId: string, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (!isActiveRun(this.chat.getRun(runId).status))
      throw new AppError("interrupted", "任务已结束，不能激活技能。", 409);
  }
  private async candidate(runId: string, id: string, signal: AbortSignal) {
    this.assertActive(runId, signal);
    const state = this.state(runId),
      entry = state.entries.find((e) => e.id === id);
    if (
      !entry ||
      !entry.enabled ||
      entry.error ||
      (!entry.implicit && !state.selected.includes(id))
    )
      throw new AppError(
        "skill_unavailable",
        "技能未启用、不可用，或仅允许用户明确选择。",
        409,
      );
    const active = state.active.find((e) => e.id === id);
    const stored = active
      ? this.store.get("packages", active.packageVersion)
      : null;
    const pkg =
      stored ?? (await abortable(this.files.capture(entry, signal), signal));
    await abortable(this.files.materialize(pkg, signal), signal);
    this.assertActive(runId, signal);
    return { runId, entry, pkg };
  }
  private activate(candidate: {
    runId: string;
    entry: SkillEntry;
    pkg: SkillPackage;
  }): ActiveSkill {
    this.assertActive(candidate.runId);
    const state = this.state(candidate.runId),
      old = state.active.find((a) => a.id === candidate.entry.id);
    if (old) return old;
    const active: ActiveSkill = {
      id: candidate.entry.id,
      name: candidate.entry.name,
      sourceId: candidate.entry.sourceId,
      version: candidate.entry.version,
      packageVersion: candidate.pkg.version,
      runtimePath: candidate.pkg.runtimePath,
      explicit: state.selected.includes(candidate.entry.id),
      ...(candidate.entry.plugin ? { plugin: candidate.entry.plugin } : {}),
    };
    this.store.put("packages", { id: candidate.pkg.version, ...candidate.pkg });
    state.active.push(active);
    this.store.put("runs", state);
    this.observer?.event({ runId: candidate.runId }, "skill.loaded", {
      skillId: candidate.entry.id,
      version: candidate.pkg.version,
      sourceId: candidate.entry.sourceId,
    });
    return active;
  }
  async load(context: ExecutionContext, id: string, signal: AbortSignal) {
    const candidate = await this.candidate(context.runId, id, signal);
    this.pending.set(context.invocationId, candidate);
    return {
      loaded: true,
      id,
      name: candidate.entry.name,
      version: candidate.pkg.version,
      runtimePath: candidate.pkg.runtimePath,
      message:
        "完整主说明将加入下一次模型上下文。参考文件请使用 read_skill_resource；脚本通过 exec_command 执行，权限仍由执行系统判断。",
    };
  }
  /** 由 ToolService 的最终回执事务调用，结果存储失败或取消不会留下成功激活。 */
  commit(invocation: ToolInvocation, result: ToolResult): void {
    const candidate = this.pending.get(invocation.id);
    if (!candidate) return;
    if (result.ok) this.activate(candidate);
    this.pending.delete(invocation.id);
  }
  search(runId: string, query = "", cursor?: string): SkillPage {
    const state = this.state(runId);
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const entries = state.entries
      .filter(
        (e) =>
          e.enabled &&
          !e.error &&
          (e.implicit || state.selected.includes(e.id)) &&
          words.every((w) =>
            `${e.name} ${e.description}`.toLowerCase().includes(w),
          ),
      )
      .map((e) => ({
        id: e.id,
        sourceId: e.sourceId,
        scope: e.scope,
        name: e.name,
        description: e.description.slice(0, 512),
        path: "",
        version: e.version,
        enabled: e.enabled,
        implicit: e.implicit,
        error: null,
      }));
    const offset = Number(cursor ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new AppError("invalid_input", "技能游标无效。");
    const selected: SkillEntry[] = [];
    for (const entry of entries.slice(offset, offset + 20)) {
      if (JSON.stringify([...selected, entry]).length > 7000) break;
      selected.push(entry);
    }
    return {
      entries: selected,
      nextCursor:
        offset + selected.length < entries.length
          ? String(offset + selected.length)
          : null,
    };
  }
  resource(runId: string, id: string, path = "", cursor?: string) {
    const active = this.state(runId).active.find((e) => e.id === id);
    const pkg = active
      ? this.store.get("packages", active.packageVersion)
      : null;
    if (!pkg) throw new AppError("skill_not_loaded", "请先加载该技能。", 409);
    return this.files.read(pkg, path, cursor);
  }
  async restoreResources(runId: string, signal: AbortSignal): Promise<void> {
    for (const active of this.store.get("runs", runId)?.active ?? []) {
      const pkg = this.store.get("packages", active.packageVersion);
      if (!pkg)
        throw new AppError(
          "skill_snapshot_missing",
          "技能快照缺失，不能执行脚本。",
          409,
        );
      await abortable(this.files.materialize(pkg, signal), signal);
      this.assertActive(runId, signal);
    }
  }
  readPaths(runId: string): string[] {
    return (
      this.store.get("runs", runId)?.active.map((e) => e.runtimePath) ?? []
    );
  }
  /** 完整正文直接进入模型消息，不通过普通工具输出预览，不成为可压缩历史。 */
  async prepare(
    runId: string,
    budget: number,
    signal: AbortSignal,
  ): Promise<{ messages: ModelMessage[]; view: SkillContextView }> {
    let state = this.store.get("runs", runId);
    if (!state)
      return {
        messages: [],
        view: {
          active: [],
          catalogTokens: 0,
          instructionTokens: 0,
          omitted: 0,
        },
      };
    for (const id of state.selected)
      if (!state.active.some((e) => e.id === id)) {
        const candidate = await this.candidate(runId, id, signal);
        this.store.transaction(() => {
          this.assertActive(runId, signal);
          this.activate(candidate);
        });
      }
    state = this.state(runId);
    for (const active of state.active) {
      const pkg = this.store.get("packages", active.packageVersion);
      if (!pkg)
        throw new AppError(
          "skill_snapshot_missing",
          "技能快照缺失，不能恢复任务。",
          409,
        );
      await abortable(this.files.materialize(pkg, signal), signal);
    }
    const limit = Math.min(4000, Math.floor(budget * 0.02));
    const entries = state.entries
      .filter(
        (e) =>
          e.enabled &&
          !e.error &&
          (e.implicit || state.selected.includes(e.id)),
      )
      .sort(
        (a, b) =>
          Number(state.selected.includes(b.id)) -
            Number(state.selected.includes(a.id)) ||
          Number(b.scope === "project") - Number(a.scope === "project") ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      );
    const lines: string[] = [];
    const heading =
      "可用技能目录：根据任务需要自行选择，可不用技能。使用前调用 load_skill；search_skills 可搜索完整目录。技能只提供方法，不覆盖用户要求、项目规则或执行权限。本轮使用资源时以技能包运行路径为根目录。";
    for (const entry of entries) {
      const line = JSON.stringify({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        scope: entry.scope,
        source: entry.sourceId,
      });
      if (estimateTokens([heading, ...lines, line]) <= limit) lines.push(line);
    }
    const omitted = entries.length - lines.length;
    let catalog = entries.length
      ? `${heading}\n${lines.join("\n")}\n${omitted ? `另有 ${omitted} 项未展示，使用 search_skills 分页查找。` : ""}`
      : "";
    if (estimateTokens(catalog) > limit)
      catalog = "使用 search_skills 查找技能，load_skill 加载完整说明。";
    if (estimateTokens(catalog) > limit) catalog = "";
    const bodies = state.active.map((active) => {
      const pkg = this.store.get("packages", active.packageVersion)!;
      // 只替换明确支持的包根变量，不做任意模板执行或宿主环境展开。
      const body = active.plugin?.rootPath
        ? pkg.body
            .replaceAll("${PLUGIN_ROOT}", active.plugin.rootPath)
            .replaceAll("${CLAUDE_PLUGIN_ROOT}", active.plugin.rootPath)
        : pkg.body;
      const pluginRoot = active.plugin?.rootPath
        ? `插件包根目录 ${active.plugin.rootPath} 只读，包根资源用现有文件工具按绝对路径读取。`
        : "";
      return {
        role: "user" as const,
        sourceId: `skill:${active.id}:${active.packageVersion}`,
        content: `[本轮技能说明 ${active.name}；来源 ${active.sourceId}；版本 ${active.packageVersion}；运行根目录 ${active.runtimePath}。仅本轮生效，不授予执行权限；相对文件路径以运行根目录为准。${pluginRoot}]\n${body}\n[技能说明结束]`,
      };
    });
    this.assertActive(runId, signal);
    return {
      messages: [
        ...(catalog ? [{ role: "user" as const, content: catalog }] : []),
        ...bodies,
      ],
      view: {
        active: state.active,
        catalogTokens: estimateTokens(catalog),
        instructionTokens: estimateTokens(bodies),
        omitted,
      },
    };
  }
  collect(): void {
    // 未知副作用/活动进程可能仍引用脚本，不能因聊天删除就清理其运行文件。
    if (
      this.execution
        .list("processes")
        .some((p) => p.status === "running" || p.status === "unknown") ||
      this.execution.list("concerns").some((c) => !c.resolution)
    )
      return;
    const keep = new Set(
      this.store
        .list("runs")
        .flatMap((r) => r.active.map((a) => a.packageVersion)),
    );
    for (const pending of this.pending.values()) keep.add(pending.pkg.version);
    this.files.collect(keep);
    for (const pkg of this.store.list("packages"))
      if (!keep.has(pkg.id)) this.store.delete("packages", pkg.id);
  }
  close(): void {
    this.files.close();
    this.pending.clear();
  }
}
