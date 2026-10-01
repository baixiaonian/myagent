/**
 * 插件管理应用服务：发布不可变包、冻结 Run 引用，并向三套既有能力提供带来源的组件。
 * 安装预览不执行组件；确认使用精确哈希和版本事务。卸载仅撤销新 Run 可见性，旧引用继续保留。
 */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AppError,
  type HookDocument,
  isActiveRun,
  type McpConfigTarget,
  type McpLiveState,
  type McpServerConfig,
  type PluginChange,
  type PluginConfirm,
  type PluginJob,
  type PluginMutation,
  type PluginReference,
  type PluginSelection,
  type PluginView,
  type Run,
  type SkillSource,
} from "@myagent/contracts";
import type {
  FrozenHook,
  HookFilesPort,
  PluginFilesPort,
} from "@myagent/extensions";
import { abortable } from "@myagent/kernel";
import type {
  ChatStore,
  CredentialStore,
  ExecutionStore,
  PluginBinding,
  PluginStore,
  PluginVersion,
  StoredMcpConnection,
  StoredPluginJob,
} from "@myagent/state";
import { validateMcpInput } from "./mcp.js";
import { mcpInput, parseMcpDocument } from "./mcp-document.js";

const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const selection = (): PluginSelection => ({ excluded: [], mcp: {} });
const scopeKey = (t: McpConfigTarget) =>
  t.scope === "user" ? "user" : `project:${t.workspaceId ?? ""}`;
export interface PluginRuntime {
  connect(id: string, workspaceId: string): Promise<unknown>;
  disconnect(id: string, workspaceId?: string): Promise<void>;
  state(id: string, workspaceId: string): McpLiveState;
}
export interface PluginHookFiles extends HookFilesPort {
  inspectPlugin(
    target: McpConfigTarget,
    document: HookDocument,
    root: string,
  ): FrozenHook[];
}
export class PluginService {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly tasks = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly connecting = new Set<string>();
  private closed = false;
  private readonly attempted = new Set<string>();
  constructor(
    readonly store: PluginStore,
    readonly files: PluginFilesPort,
    private readonly chat: ChatStore,
    private readonly execution: ExecutionStore,
    private readonly credentials: CredentialStore,
    private readonly hookFiles: PluginHookFiles,
    private readonly runtime: PluginRuntime,
    private readonly diagnostic?: () => Promise<{ id: string }>,
  ) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.catch(() => {}).then(fn);
    this.tail = p;
    return p;
  }
  private target(t: McpConfigTarget): McpConfigTarget {
    if (t.scope === "user") return { scope: "user" };
    if (
      t.scope !== "project" ||
      !t.workspaceId ||
      !this.execution.get("workspaces", t.workspaceId)
    )
      throw new AppError("invalid_target", "请选择有效项目。");
    return { scope: "project", workspaceId: t.workspaceId };
  }
  private bindingId(t: McpConfigTarget, id: string) {
    return `${scopeKey(t)}:${id}`;
  }
  private current(t: McpConfigTarget, id: string) {
    return this.store.get("bindings", this.bindingId(t, id));
  }
  private revision(t: McpConfigTarget, id: string, expected: number) {
    if ((this.current(t, id)?.revision ?? 0) !== expected)
      throw new AppError("revision_conflict", "插件状态已变化，请刷新。", 409);
  }
  private version(id: string): PluginVersion {
    const v = this.store.get("versions", id);
    if (!v) throw new AppError("plugin_missing", "插件版本不存在。", 404);
    return v;
  }
  private effective(workspaceId?: string): PluginBinding[] {
    const all = this.store.list("bindings");
    const project = new Map(
      all
        .filter(
          (b) =>
            !b.inherit &&
            b.target.workspaceId === workspaceId &&
            b.target.scope === "project",
        )
        .map((b) => [b.pluginId, b]),
    );
    return [
      ...all.filter(
        (b) => b.target.scope === "user" && !project.has(b.pluginId),
      ),
      ...project.values(),
    ]
      .filter((b) => b.enabled && !b.removed)
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  }
  private visible(workspaceId?: string, runId?: string) {
    return runId
      ? (this.store.get("runs", runId)?.bindings ?? [])
      : this.effective(workspaceId);
  }
  private origin(b: PluginBinding, componentId: string) {
    const v = this.version(b.versionId);
    return {
      pluginId: b.pluginId,
      name: v.manifest.name,
      version: v.package.version,
      rootPath: v.package.runtimePath,
      componentId,
    };
  }
  /** 输入凭证只能在确认时提交，配置快照不得偷偷带入 token/env 明文。 */
  private validateSelection(
    value: PluginSelection,
    v: PluginVersion,
  ): PluginSelection {
    if (
      !value ||
      !Array.isArray(value.excluded) ||
      !value.mcp ||
      typeof value.mcp !== "object" ||
      value.excluded.some(
        (id) => !v.manifest.components.some((c) => c.id === id),
      )
    )
      throw new AppError("invalid_plugin", "组件选择无效。");
    for (const [id, config] of Object.entries(value.mcp)) {
      if (!v.manifest.components.some((c) => c.id === id && c.kind === "mcp"))
        throw new AppError("invalid_plugin", "MCP 组件不存在。");
      if (config.env || config.token)
        throw new AppError("invalid_plugin", "凭证必须通过独立凭证字段提交。");
      parseMcpDocument(JSON.stringify({ mcpServers: { component: config } }));
    }
    return { excluded: [...new Set(value.excluded)].sort(), mcp: value.mcp };
  }
  async preview(input: PluginMutation): Promise<PluginJob> {
    if (this.closed) throw new AppError("unavailable", "服务正在关闭。");
    const target = this.target(input),
      id = `preview:${input.requestId}`,
      fingerprint = hash(input);
    const previous = this.store.get("jobs", id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError(
          "idempotency_conflict",
          "请求标识已用于另一操作。",
          409,
        );
      return this.publicJob(previous);
    }
    const old = input.pluginId
      ? ((this.current(target, input.pluginId)?.inherit
          ? undefined
          : this.current(target, input.pluginId)) ??
        this.effective(target.workspaceId).find(
          (b) => b.pluginId === input.pluginId,
        ))
      : undefined;
    if (input.action !== "install" && !old)
      throw new AppError("not_found", "插件尚未安装。", 404);
    if (input.pluginId)
      this.revision(target, input.pluginId, input.expectedRevision);
    const source =
      input.source ?? (old ? this.version(old.versionId).source : null);
    if (!source) throw new AppError("invalid_plugin", "请选择插件来源。");
    if (source.kind === "git") {
      let url: URL;
      try {
        url = new URL(source.url);
      } catch {
        throw new AppError("invalid_plugin_source", "Git 地址无效。");
      }
      if (
        url.username ||
        url.password ||
        url.protocol !== "https:" ||
        url.search ||
        url.hash
      )
        throw new AppError(
          "invalid_plugin_source",
          "仅支持不含凭证的公开 HTTPS 地址。",
        );
    }
    // 在任何持久化之前拒绝把明文认证材料混入配置；失败任务也属于公开管理记录。
    if (input.selection) {
      if (
        !Array.isArray(input.selection.excluded) ||
        !input.selection.mcp ||
        typeof input.selection.mcp !== "object"
      )
        throw new AppError("invalid_plugin", "组件选择无效。");
      for (const config of Object.values(input.selection.mcp)) {
        if (!config || config.env || config.token !== undefined)
          throw new AppError(
            "invalid_plugin",
            "凭证必须通过独立确认字段提交。",
          );
        parseMcpDocument(JSON.stringify({ mcpServers: { component: config } }));
      }
    }
    const job: StoredPluginJob = {
      id,
      pluginId: input.pluginId ?? "",
      target,
      action: input.action,
      status: "preparing",
      manifest: null,
      version: null,
      commit: null,
      source,
      enabled: input.enabled,
      selection:
        input.selection ??
        (input.action === "rollback" ? old?.previousSelection : undefined) ??
        old?.selection ??
        selection(),
      expectedRevision: input.expectedRevision,
      confirmation: null,
      error: null,
      createdAt: new Date().toISOString(),
      noChange: false,
      fingerprint,
    };
    this.store.put("jobs", job);
    const controller = new AbortController();
    const done = this.prepare(job, old, controller.signal);
    this.tasks.set(id, { controller, done });
    void done.finally(() => this.tasks.delete(id));
    return this.publicJob(this.store.get("jobs", id)!);
  }
  private async prepare(
    job: StoredPluginJob,
    old: PluginBinding | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const existing =
        old && (job.action === "configure" || job.action === "rollback")
          ? this.version(
              job.action === "rollback"
                ? (old.previousVersionId ?? "")
                : old.versionId,
            )
          : null;
      const candidate = existing
        ? { ...existing, package: existing.package }
        : await this.files.prepare(job.source, signal);
      signal.throwIfAborted();
      await this.files.restore(candidate.package, signal);
      const identity = hash([
        candidate.source.kind === "local"
          ? ["local", candidate.source.path]
          : ["git", candidate.source.url, candidate.source.subdirectory ?? ""],
        candidate.manifest.name,
      ]);
      if (job.pluginId && job.pluginId !== identity)
        throw new AppError("plugin_identity", "更新不能改变插件来源或名称。");
      const pluginId = job.pluginId || identity;
      const v: PluginVersion = {
        id: `${pluginId}:${candidate.package.version}`,
        pluginId,
        package: candidate.package,
        manifest: candidate.manifest,
        source: candidate.source,
        commit: candidate.commit,
      };
      // 更新可移除组件，旧选择只复用仍存在的身份；预览展示差异后重新确认。
      if (job.action === "update" || job.action === "rollback") {
        const ids = new Set(v.manifest.components.map((c) => c.id));
        job.selection = {
          excluded: job.selection.excluded.filter((id) => ids.has(id)),
          mcp: Object.fromEntries(
            Object.entries(job.selection.mcp).filter(([id]) => ids.has(id)),
          ),
        };
      }
      job.selection = this.validateSelection(job.selection, v);
      for (const c of v.manifest.components)
        if (c.mcp) {
          const config = { ...c.mcp, ...job.selection.mcp[c.id] };
          try {
            this.config(v, config);
          } catch (e) {
            v.manifest.issues.push({
              id: `validation:${c.id}`,
              componentId: c.id,
              blocking: true,
              message: e instanceof AppError ? e.message : "MCP 配置无效。",
            });
          }
        }
      if (this.store.get("jobs", job.id)?.status !== "preparing") return;
      this.store.transaction(() => {
        this.store.put("versions", v);
        this.store.put("jobs", {
          ...job,
          pluginId,
          manifest: v.manifest,
          version: v.package.version,
          source: v.source,
          commit: v.commit,
          candidateId: v.id,
          status: "ready",
          confirmation: hash([
            job.id,
            v.package.version,
            job.target,
            job.enabled,
            job.selection,
            job.expectedRevision,
          ]),
          noChange:
            !!old &&
            scopeKey(old.target) === scopeKey(job.target) &&
            !old.inherit &&
            old.versionId === v.id &&
            hash(old.selection) === hash(job.selection) &&
            old.enabled === job.enabled &&
            !old.removed,
        });
      });
    } catch (e) {
      const now = this.store.get("jobs", job.id);
      if (now?.status === "preparing")
        this.store.put("jobs", {
          ...now,
          status: signal.aborted ? "cancelled" : "failed",
          error:
            e instanceof AppError
              ? e.message
              : "插件准备失败，请检查来源和包内容。",
        });
    }
  }
  private publicJob(job: StoredPluginJob): PluginJob {
    const {
      fingerprint: _,
      candidateId: _c,
      staged: _s,
      newCredentialRefs: _r,
      committedBindingId: _b,
      ...safe
    } = job;
    return safe;
  }
  jobs(target: McpConfigTarget): PluginJob[] {
    const t = this.target(target);
    return this.store
      .list("jobs")
      .filter((j) => scopeKey(j.target) === scopeKey(t))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
      .map((j) => this.publicJob(j));
  }
  job(id: string): PluginJob {
    const value = this.store.get("jobs", id);
    if (!value) throw new AppError("not_found", "安装任务不存在。", 404);
    return this.publicJob(value);
  }
  cancel(id: string, requestId?: string): PluginJob {
    const operation = requestId ? `cancel:${requestId}` : null;
    const previous = operation ? this.store.get("operations", operation) : null;
    if (previous) {
      if (previous.fingerprint !== hash(id))
        throw new AppError(
          "idempotency_conflict",
          "取消请求已用于另一任务。",
          409,
        );
      return previous.value as PluginJob;
    }
    const job = this.store.get("jobs", id);
    if (!job) throw new AppError("not_found", "任务不存在。", 404);
    if (job.status === "preparing" || job.status === "ready") {
      this.store.transaction(() => {
        this.store.put("jobs", { ...job, status: "cancelled" });
        if (operation)
          this.store.put("operations", {
            id: operation,
            fingerprint: hash(id),
            value: this.job(id),
          });
      });
      this.tasks.get(id)?.controller.abort();
    } else if (operation)
      this.store.put("operations", {
        id: operation,
        fingerprint: hash(id),
        value: this.job(id),
      });
    return this.job(id);
  }
  /** 发布只在事务末尾切换可见版本；Hook 捕获可取消且不得改变用户的独立配置。 */
  confirm(id: string, input: PluginConfirm): Promise<PluginView> {
    return this.serial(async () => {
      const job = this.store.get("jobs", id);
      if (!job) throw new AppError("not_found", "任务不存在。", 404);
      const operation = `confirm:${input.requestId}`,
        fingerprint = hash([id, input]);
      const previous = this.store.get("operations", operation);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new AppError(
            "idempotency_conflict",
            "确认请求已用于不同内容。",
            409,
          );
        return previous.value as PluginView;
      }
      if (
        job.status !== "ready" ||
        job.confirmation !== input.confirmation ||
        !job.candidateId
      )
        throw new AppError(
          "revision_conflict",
          "请重新预览并确认准确版本。",
          409,
        );
      this.revision(job.target, job.pluginId, job.expectedRevision);
      const v = this.version(job.candidateId);
      this.files.verify(v.package);
      if (
        job.enabled &&
        v.manifest.issues.some(
          (i) => i.blocking && !job.selection.excluded.includes(i.componentId),
        )
      )
        throw new AppError(
          "plugin_incompatible",
          "请适配或明确排除不支持的组件后启用。",
          409,
        );
      const old = this.current(job.target, job.pluginId),
        newRefs: string[] = [];
      if (
        Object.keys(input.credentials ?? {}).some(
          (id) =>
            !v.manifest.components.some((c) => c.id === id && c.kind === "mcp"),
        )
      )
        throw new AppError("invalid_plugin", "凭证目标组件不存在。");
      if (job.noChange && old && !Object.keys(input.credentials ?? {}).length) {
        const value = this.viewBinding(old, false);
        this.store.transaction(() => {
          this.store.put("jobs", {
            ...job,
            status: "committed",
            committedBindingId: old.id,
          });
          this.store.put("operations", { id: operation, fingerprint, value });
        });
        return value;
      }
      const slots: PluginBinding["credentialSlots"] = {};
      try {
        for (const c of v.manifest.components.filter((c) => c.kind === "mcp")) {
          const config = { ...c.mcp, ...job.selection.mcp[c.id] },
            prior = old
              ? this.version(old.versionId).manifest.components.find(
                  (x) => x.id === c.id,
                )
              : null;
          const authenticationIdentity = (value: McpServerConfig) =>
            hash([
              value.transport ?? (value.url ? "http" : "stdio"),
              value.command ?? "",
              value.args ?? [],
              value.url ?? "",
              value.auth ?? "none",
              value.clientId ?? "",
              value.clientMetadataUrl ?? "",
            ]);
          const unchanged =
            !old?.inherit &&
            prior &&
            authenticationIdentity({
              ...prior.mcp,
              ...old?.selection.mcp[c.id],
            }) === authenticationIdentity(config);
          const saved = unchanged ? old?.credentialSlots[c.id] : undefined,
            submitted = input.credentials?.[c.id];
          // 凭证通道不能变成执行环境逃逸通道，沿用独立 MCP 的加载器/代理变量限制。
          if (submitted?.environment)
            validateMcpInput({
              ...mcpInput("plugin", this.config(v, config)),
              environment: submitted.environment,
            });
          const put = (value: string) => {
            const ref = randomUUID();
            this.store.put("credentials", { id: ref });
            this.credentials.write(ref, value);
            newRefs.push(ref);
            return ref;
          };
          slots[c.id] = {
            token:
              submitted?.token !== undefined
                ? submitted.token
                  ? put(submitted.token)
                  : null
                : (saved?.token ?? null),
            environment: submitted?.environment
              ? Object.fromEntries(
                  Object.entries(submitted.environment)
                    .filter(([, x]) => x)
                    .map(([k, x]) => [k, put(x)]),
                )
              : (saved?.environment ?? {}),
          };
        }
        const definition = {
          schemaVersion: 1 as const,
          hooks: v.manifest.components
            .filter((c) => c.hook && !job.selection.excluded.includes(c.id))
            .map((c) => ({
              ...c.hook!,
              packagePath: join(v.package.runtimePath, c.hook!.packagePath),
            })),
        };
        const frozen = job.enabled
          ? this.hookFiles.inspectPlugin(
              job.target,
              definition,
              v.package.runtimePath,
            )
          : [];
        await this.hookFiles.capture(frozen, new AbortController().signal);
        const configVersion = hash([v.package.version, job.selection, slots]);
        const binding: PluginBinding = {
          id: this.bindingId(job.target, job.pluginId),
          pluginId: job.pluginId,
          target: job.target,
          revision: (old?.revision ?? 0) + 1,
          versionId: v.id,
          previousSelection:
            old?.versionId !== v.id
              ? (old?.selection ?? null)
              : (old?.previousSelection ?? null),
          previousVersionId:
            old?.inherit || old?.removed
              ? null
              : old?.versionId !== v.id
                ? (old?.versionId ?? null)
                : (old?.previousVersionId ?? null),
          enabled: job.enabled,
          removed: false,
          selection: job.selection,
          configurationVersion: configVersion,
          hooks: frozen.map((h) => ({
            ...h,
            id: `plugin:${job.pluginId}:${configVersion}:${h.id}`,
            plugin: {
              pluginId: job.pluginId,
              name: v.manifest.name,
              version: v.package.version,
              componentId: `hook:${h.definition.id}`,
            },
          })),
          credentialSlots: slots,
        };
        if (this.store.get("jobs", id)?.status !== "ready")
          throw new AppError("cancelled", "安装已取消。");
        this.store.put("jobs", {
          ...job,
          staged: binding,
          newCredentialRefs: newRefs,
        });
        this.store.transaction(() => {
          this.revision(job.target, job.pluginId, job.expectedRevision);
          if (this.store.get("jobs", id)?.status !== "ready")
            throw new AppError("cancelled", "安装确认已取消。");
          this.store.put("bindings", binding);
          this.store.put("jobs", {
            ...job,
            status: "committed",
            committedBindingId: binding.id,
          });
          this.store.put("operations", {
            id: operation,
            fingerprint,
            value: this.viewBinding(binding, false),
          });
        });
        // 显式清除是撤销操作，旧任务也不能继续使用已撤销的凭证。
        for (const [component, submitted] of Object.entries(
          input.credentials ?? {},
        )) {
          const previous = old?.credentialSlots[component];
          if (submitted.token === "" && previous?.token)
            this.credentials.remove(previous.token);
          if (
            submitted.environment &&
            !Object.keys(submitted.environment).length
          )
            for (const ref of Object.values(previous?.environment ?? {}))
              this.credentials.remove(ref);
        }
        await this.maintainNow();
        return this.viewBinding(binding, false);
      } catch (e) {
        const current = this.store.get("jobs", id);
        if (!current?.staged && current?.status !== "committed")
          for (const ref of newRefs) this.credentials.remove(ref);
        throw e;
      }
    });
  }
  change(id: string, input: PluginChange): Promise<PluginView[]> {
    return this.serial(async () => {
      const target = this.target(input),
        operation = `change:${input.requestId}`,
        fingerprint = hash([id, input]),
        previous = this.store.get("operations", operation);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new AppError(
            "idempotency_conflict",
            "请求已用于不同内容。",
            409,
          );
        return previous.value as PluginView[];
      }
      this.revision(target, id, input.expectedRevision);
      const old =
        this.current(target, id) ??
        this.effective(target.workspaceId).find((b) => b.pluginId === id);
      if (!old) throw new AppError("not_found", "插件不存在。", 404);
      this.store.transaction(() => {
        if (input.action === "inherit") {
          if (target.scope !== "project")
            throw new AppError("invalid_target", "只有项目支持恢复继承。");
          this.store.put("bindings", {
            ...old,
            id: this.bindingId(target, id),
            target,
            revision: input.expectedRevision + 1,
            inherit: true,
            credentialSlots: {},
            hooks: [],
            enabled: false,
            removed: false,
          });
        } else
          this.store.put("bindings", {
            ...old,
            id: this.bindingId(target, id),
            target,
            revision: input.expectedRevision + 1,
            inherit: false,
            credentialSlots:
              !old.inherit && scopeKey(old.target) === scopeKey(target)
                ? old.credentialSlots
                : {},
            enabled: false,
            removed: input.action === "uninstall",
          });
        this.store.put("operations", {
          id: operation,
          fingerprint,
          value: this.list(target),
        });
      });
      await this.maintainNow();
      return this.list(target);
    });
  }
  private liveRun(binding: PluginBinding): string[] {
    return this.store
      .list("runs")
      .filter(
        (r) =>
          r.bindings.some(
            (b) => b.pluginId === binding.pluginId && b.id === binding.id,
          ) && this.runNeeded(r.runId),
      )
      .map((r) => r.runId);
  }
  private runNeeded(id: string): boolean {
    try {
      if (
        isActiveRun(this.chat.getRun(id).status) ||
        (this.execution.get("checkpoints", id) &&
          this.chat.getRun(id).status === "interrupted")
      )
        return true;
    } catch {}
    return (
      this.execution
        .list("processes")
        .some(
          (p) => p.runId === id && ["running", "unknown"].includes(p.status),
        ) ||
      this.execution
        .list("invocations")
        .some((i) => i.runId === id && i.status === "unknown" && !i.resolution)
    );
  }
  private viewBinding(
    b: PluginBinding,
    inherited: boolean,
    workspaceId?: string,
  ): PluginView {
    const v = this.version(b.versionId);
    const activeRunIds = this.liveRun(b),
      connections = this.execution
        .list("connections")
        .filter(
          (c) =>
            c.pluginBinding === b.configurationVersion &&
            c.plugin?.pluginId === b.pluginId &&
            (!workspaceId || c.workspaceIds.includes(workspaceId)),
        )
        .map((c) => ({
          componentId: c.plugin!.componentId,
          connectionId: c.id,
          workspaceId: c.workspaceIds[0] ?? "",
          state: this.runtime.state(
            c.id,
            workspaceId ?? c.workspaceIds[0] ?? "",
          ),
        }));
    return {
      pluginId: b.pluginId,
      name: v.manifest.name,
      description: v.manifest.description,
      source: v.source,
      target: b.target,
      revision: inherited ? 0 : b.revision,
      inherited,
      enabled: b.enabled,
      removed: b.removed,
      version: v.package.version,
      declaredVersion: v.manifest.declaredVersion,
      commit: v.commit,
      previousVersion: b.previousVersionId
        ? this.version(b.previousVersionId).package.version
        : null,
      selection: b.selection,
      manifest: v.manifest,
      activeRunIds,
      connections,
      status:
        b.removed &&
        (activeRunIds.length ||
          this.execution.list("concerns").some((c) => !c.resolution))
          ? "pending_cleanup"
          : b.enabled
            ? connections.some(
                (c) => c.state.status === "authorization_required",
              )
              ? "configuration_required"
              : connections.some((c) =>
                    ["error", "disconnected"].includes(c.state.status),
                  )
                ? "degraded"
                : "enabled"
            : b.removed
              ? "installed"
              : "disabled",
    };
  }
  list(input: McpConfigTarget): PluginView[] {
    const target = this.target(input),
      all = this.store.list("bindings");
    const local = all.filter(
      (b) => scopeKey(b.target) === scopeKey(target) && !b.inherit,
    );
    const inherited =
      target.scope === "project"
        ? all.filter(
            (b) =>
              b.target.scope === "user" &&
              !local.some((x) => x.pluginId === b.pluginId),
          )
        : [];
    return [
      ...local.map((b) => this.viewBinding(b, false, target.workspaceId)),
      ...inherited.map((b) => ({
        ...this.viewBinding(b, true, target.workspaceId),
        revision: this.current(target, b.pluginId)?.revision ?? 0,
      })),
    ].filter(
      (v) =>
        !v.removed ||
        v.status === "pending_cleanup" ||
        target.scope === "project",
    );
  }
  /** Run 引用先落库，三类组件再从同一集合初始化；这里没有任何进程或网络动作。 */
  initialize(run: Run, parentRunId?: string): void {
    if (parentRunId) {
      const source = this.store.get("runs", parentRunId);
      if (!source) {
        if (!this.chat.snapshot(run.sessionId).session.workspaceId) return;
        throw new AppError("checkpoint_missing", "主任务扩展快照不存在。", 409);
      }
      this.store.put("runs", {
        ...source,
        id: run.id,
        runId: run.id,
        sessionId: run.sessionId,
      });
      return;
    }
    const session = this.chat.snapshot(run.sessionId).session;
    if (!session.workspaceId) return;
    const bindings = this.effective(session.workspaceId);
    for (const b of bindings)
      this.files.verify(this.version(b.versionId).package);
    const references = bindings.map((b) => ({
      pluginId: b.pluginId,
      name: this.version(b.versionId).manifest.name,
      version: this.version(b.versionId).package.version,
      bindingId: b.id,
      configurationVersion: b.configurationVersion,
    }));
    this.store.put("runs", {
      id: run.id,
      runId: run.id,
      sessionId: run.sessionId,
      workspaceId: session.workspaceId,
      bindings,
      references,
    });
    this.ensureConnections(bindings, session.workspaceId);
  }
  /** 只读边界来自服务端冻结版本，不能由模型参数扩大；权限撤销仍由原执行链路核验。 */
  readPaths(runId: string): string[] {
    return this.visible(undefined, runId).map(
      (b) => this.version(b.versionId).package.runtimePath,
    );
  }
  references(runId: string): PluginReference[] {
    return this.store.get("runs", runId)?.references ?? [];
  }
  skillSources(workspaceId?: string, runId?: string): SkillSource[] {
    return this.visible(workspaceId, runId).flatMap((b) => {
      const v = this.version(b.versionId);
      return v.manifest.components
        .filter(
          (c) => c.kind === "skill" && !b.selection.excluded.includes(c.id),
        )
        .map((c) => ({
          id: `plugin:${b.pluginId}:${v.package.version}:${c.id}`,
          path: join(v.package.runtimePath, c.path!),
          scope: b.target.scope,
          workspaceId: b.target.workspaceId ?? null,
          enabled: true,
          builtin: false,
          revision: b.revision,
          plugin: this.origin(b, c.id),
        }));
    });
  }
  hooks(runId: string, scope: "user" | "project") {
    return this.visible(undefined, runId)
      .filter((b) => b.target.scope === scope)
      .flatMap((b) => b.hooks);
  }
  allows(connectionId: string, workspaceId: string, runId?: string): boolean {
    const c = this.execution.get("connections", connectionId);
    if (!c?.plugin) return true;
    if (!c.workspaceIds.includes(workspaceId)) return false;
    return this.visible(workspaceId, runId).some(
      (b) =>
        b.pluginId === c.plugin!.pluginId &&
        b.configurationVersion === c.pluginBinding &&
        !b.selection.excluded.includes(c.plugin!.componentId),
    );
  }
  guard(id: string, workspaceId: string, runId?: string): void {
    if (!this.allows(id, workspaceId, runId))
      throw new AppError("plugin_unavailable", "插件不属于本轮固定版本。", 409);
    const c = this.execution.get("connections", id);
    if (c?.plugin) {
      for (const ref of [c.credentialRef, ...Object.values(c.environmentRefs)])
        if (ref && !this.credentials.read(ref))
          throw new AppError(
            "credential_revoked",
            "插件凭证已撤销，请重新配置。",
            403,
          );
      const b = this.visible(workspaceId, runId).find(
        (x) => x.pluginId === c.plugin!.pluginId,
      )!;
      this.files.verify(this.version(b.versionId).package);
    }
  }
  private config(v: PluginVersion, config: McpServerConfig): McpServerConfig {
    const text = JSON.stringify(config)
      .replaceAll("${PLUGIN_ROOT}", v.package.runtimePath)
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", v.package.runtimePath);
    const value = JSON.parse(text) as McpServerConfig;
    parseMcpDocument(JSON.stringify({ mcpServers: { component: value } }));
    validateMcpInput(mcpInput("plugin", value));
    return value;
  }
  private ensureConnections(
    bindings: PluginBinding[],
    workspaceId: string,
  ): StoredMcpConnection[] {
    const records: StoredMcpConnection[] = [];
    for (const b of bindings) {
      const v = this.version(b.versionId);
      for (const c of v.manifest.components) {
        if (!c.mcp || b.selection.excluded.includes(c.id)) continue;
        const config = this.config(v, { ...c.mcp, ...b.selection.mcp[c.id] });
        if (config.enabled === false) continue;
        const id = `plugin-${hash([b.id, b.configurationVersion, c.id, workspaceId])}`;
        let record = this.execution.get("connections", id);
        if (!record) {
          const slots = b.credentialSlots[c.id];
          record = {
            id,
            plugin: this.origin(b, c.id),
            pluginBinding: b.configurationVersion,
            pluginScope: b.target.scope,
            pluginReadOnlyPaths: [v.package.runtimePath],
            name: `${v.manifest.name}/${c.name}`.slice(0, 100),
            transport: config.transport ?? (config.url ? "http" : "stdio"),
            toolExposure: config.toolExposure ?? "deferred",
            command: config.command ?? "",
            args: config.args ?? [],
            networkDomains: config.networkDomains ?? [],
            additionalPaths: [
              ...(config.additionalPaths ?? []),
              { path: v.package.runtimePath, access: "read" },
            ],
            url: config.url ?? "",
            workspaceIds: [workspaceId],
            environmentNames: Object.keys(slots?.environment ?? {}),
            environmentRefs: slots?.environment ?? {},
            credentialRef: slots?.token ?? null,
            oauthRef: null,
            auth: config.auth ?? "none",
            clientId: config.clientId ?? "",
            clientMetadataUrl: config.clientMetadataUrl ?? "",
            status: "disconnected",
            revision: 0,
            createdAt: new Date().toISOString(),
            enabled: true,
          };
          this.execution.put("connections", record);
        }
        records.push(record);
      }
    }
    return records;
  }
  async connectRun(runId: string, signal?: AbortSignal): Promise<void> {
    const state = this.store.get("runs", runId);
    if (!state) return;
    const pending = this.connect(
      this.ensureConnections(state.bindings, state.workspaceId),
    );
    if (signal) await abortable(pending, signal);
    else await pending;
  }
  private async connect(records: StoredMcpConnection[]) {
    await Promise.all(
      records.map(async (c) => {
        const key = c.id;
        if (this.connecting.has(key) || this.attempted.has(key)) return;
        this.attempted.add(key);
        this.connecting.add(key);
        try {
          await this.runtime.connect(c.id, c.workspaceIds[0]!);
        } catch {
          /* 实时状态由 MCP 提供；连接失败不伪造整包成功。 */
        } finally {
          this.connecting.delete(key);
        }
      }),
    );
  }
  /** 管理引用与 Run 引用分别计算；停止/卸载不等同副作用回滚，未知记录阻止物理清理。 */
  maintain(): Promise<void> {
    return this.serial(() => this.maintainNow());
  }
  private async maintainNow(): Promise<void> {
    if (this.closed) return;
    const keepConnections = new Set<string>(),
      keepPackages = new Set<string>();
    const records: StoredMcpConnection[] = [];
    for (const b of this.store
      .list("bindings")
      .filter((b) => !b.removed && !b.inherit)) {
      keepPackages.add(this.version(b.versionId).package.version);
      if (b.previousVersionId)
        keepPackages.add(this.version(b.previousVersionId).package.version);
    }
    for (const job of this.store.list("jobs"))
      if (["preparing", "ready"].includes(job.status) && job.candidateId)
        keepPackages.add(this.version(job.candidateId).package.version);
    if (
      this.diagnostic &&
      this.effective().some((b) =>
        this.version(b.versionId).manifest.components.some((c) => c.mcp),
      ) &&
      !this.execution.list("workspaces").length
    )
      await this.diagnostic();
    for (const w of this.execution.list("workspaces")) {
      const current = this.effective(w.id);
      for (const c of this.ensureConnections(current, w.id)) {
        keepConnections.add(c.id);
        records.push(c);
      }
    }
    for (const r of this.store.list("runs"))
      if (this.runNeeded(r.runId)) {
        for (const b of r.bindings)
          keepPackages.add(this.version(b.versionId).package.version);
        for (const c of this.ensureConnections(r.bindings, r.workspaceId))
          keepConnections.add(c.id);
      }
    for (const c of this.execution.list("connections"))
      if (
        c.plugin &&
        !keepConnections.has(c.id) &&
        !this.execution.list("concerns").some((c) => !c.resolution)
      ) {
        await this.runtime.disconnect(c.id);
        if (c.oauthRef) this.store.put("credentials", { id: c.oauthRef });
        this.execution.remove("connections", c.id);
      }
    const keptRefs = new Set<string>();
    const remember = (b: PluginBinding) => {
      for (const slot of Object.values(b.credentialSlots)) {
        if (slot.token) keptRefs.add(slot.token);
        for (const ref of Object.values(slot.environment)) keptRefs.add(ref);
      }
    };
    for (const b of this.store.list("bindings"))
      if (!b.removed && !b.inherit) remember(b);
    for (const r of this.store.list("runs"))
      if (this.runNeeded(r.runId)) for (const b of r.bindings) remember(b);
    for (const c of this.execution.list("connections"))
      for (const ref of [
        c.credentialRef,
        c.oauthRef,
        ...Object.values(c.environmentRefs),
      ])
        if (ref) keptRefs.add(ref);
    for (const job of this.store.list("jobs"))
      for (const ref of job.newCredentialRefs ?? []) keptRefs.add(ref);
    for (const record of this.store.list("credentials"))
      if (!keptRefs.has(record.id)) {
        this.credentials.remove(record.id);
        this.store.delete("credentials", record.id);
      }
    // 未解决 Hook 副作用可能没有普通工具 invocation，保留对应包，待人工核对后回收。
    if (
      !this.execution.list("concerns").some((c) => !c.resolution) &&
      !this.tasks.size
    )
      this.files.collect(keepPackages);
    await this.connect(records);
  }
  async recover(): Promise<void> {
    for (const j of this.store.list("jobs")) {
      if (j.status === "preparing")
        this.store.put("jobs", {
          ...j,
          status: "interrupted",
          error: "服务重启，安装未自动重试。",
        });
      if (j.staged) {
        for (const ref of j.newCredentialRefs ?? [])
          this.credentials.remove(ref);
        const { staged: _, newCredentialRefs: _r, ...rest } = j;
        this.store.put("jobs", {
          ...rest,
          status: "interrupted",
          error: "发布未完成，请重新预览确认。",
        });
      }
    }
    const needed = new Set(
      this.store
        .list("bindings")
        .filter((b) => !b.removed && !b.inherit)
        .flatMap((b) => [
          b.versionId,
          ...(b.previousVersionId ? [b.previousVersionId] : []),
        ]),
    );
    for (const r of this.store.list("runs"))
      if (this.runNeeded(r.runId))
        for (const b of r.bindings) needed.add(b.versionId);
    for (const j of this.store.list("jobs"))
      if (j.status === "ready" && j.candidateId) needed.add(j.candidateId);
    for (const id of needed)
      await this.files.restore(
        this.version(id).package,
        new AbortController().signal,
      );
  }
  async close() {
    this.closed = true;
    for (const t of this.tasks.values()) t.controller.abort();
    await Promise.allSettled([...this.tasks.values()].map((t) => t.done));
    await this.tail.catch(() => {});
  }
}
