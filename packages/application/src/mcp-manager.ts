/**
 * MCP 文件配置协调器：负责双作用域、可信版本、迁移日志与按项目激活；不执行模型循环。
 * 文件是配置事实源，SQLite 仅保存稳定身份/秘密引用/已确认版本及可恢复提交日志。
 * 外部项目文件改变先阻止新派发，只有用户确认准确哈希后才允许启动新命令。
 */
import {
  AppError,
  type McpConfigConfirmation,
  type McpConfigDocument,
  type McpConfigSave,
  type McpConfigTarget,
  type McpConfigView,
  type McpConnection,
  type McpConnectionInput,
  type McpLiveState,
  type McpOverview,
  type McpRemoval,
  type Workspace,
} from "@myagent/contracts";
import type {
  CredentialStore,
  ExecutionStore,
  McpConfigFilePort,
  McpFileState,
  StoredMcpConnection,
} from "@myagent/state";
import type { McpManagementPort, McpSettingsService } from "./mcp.js";
import {
  mcpInput,
  parseMcpDocument,
  sanitizeMcpDocument,
  secretSlot,
} from "./mcp-document.js";
import type { ProjectService } from "./projects.js";

export interface ManagedMcpRuntime extends McpManagementPort {
  state(id: string, workspaceId: string): McpLiveState;
  probe?(id: string, workspaceId: string): Promise<void>;
  disconnect(id: string, workspaceId?: string): Promise<void>;
}
const empty = (): McpConfigDocument => ({ mcpServers: {} });
const cleanTarget = (target: McpConfigTarget): McpConfigTarget =>
  target.scope === "user"
    ? { scope: "user" }
    : { scope: "project", workspaceId: target.workspaceId ?? "" };
const fileId = (target: McpConfigTarget) =>
  target.scope === "user" ? "user" : `project:${target.workspaceId}`;
/** 排序对象键比较配置语义；纯排版变化不撤销信任或中断其他服务。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export class McpManager {
  pluginOverview?: (
    workspaceId: string,
  ) => import("@myagent/contracts").McpServerView[];
  private readonly removals = new Map<string, McpRemoval>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly contexts = new Map<string, Workspace>();
  private readonly attempted = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private stopped = false;
  constructor(
    private readonly store: ExecutionStore,
    private readonly credentials: CredentialStore,
    readonly files: McpConfigFilePort,
    private readonly runtime: ManagedMcpRuntime,
    private readonly legacy: McpSettingsService,
    private readonly projects: ProjectService,
    private readonly id: () => string,
  ) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => {}).then(fn);
    this.tail = result;
    return result;
  }
  private connections(target: McpConfigTarget) {
    return this.store
      .list("connections")
      .filter((c) => c.source?.fileId === fileId(target));
  }
  /** 迁移先写可恢复日志，再写文件；既有文件中的同名项不会被旧数据库配置覆盖。 */
  async initialize(): Promise<void> {
    await this.serial(async () => {
      const target: McpConfigTarget = { scope: "user" };
      await this.recover(target);
      const legacy = this.store
        .list("connections")
        .filter((c) => !c.source && !c.plugin);
      if (!legacy.length) return;
      const disk = await this.files.read(target);
      const document = parseMcpDocument(disk.text);
      const records: StoredMcpConnection[] = [];
      for (const old of legacy) {
        let key =
          old.name.replace(/[^\p{L}\p{N}_.-]/gu, "_").slice(0, 70) || "server";
        if (Object.hasOwn(document.mcpServers, key))
          key = `${key}_${old.id.slice(0, 8)}`;
        document.mcpServers[key] = {
          transport: old.transport,
          toolExposure: old.toolExposure ?? "deferred",
          command: old.command,
          args: old.args,
          url: old.url,
          enabled: true,
          auth: old.auth,
          clientId: old.clientId,
          clientMetadataUrl: old.clientMetadataUrl,
          networkDomains: old.networkDomains,
          additionalPaths: old.additionalPaths,
          workspaceIds: old.workspaceIds,
          ...(old.credentialRef ? { token: secretSlot("token") } : {}),
          env: Object.fromEntries(
            Object.keys(old.environmentRefs).map((name) => [
              name,
              secretSlot(`env.${name}`),
            ]),
          ),
        };
        records.push({
          ...old,
          source: { ...target, key, fileId: "user" },
          enabled: true,
          allowedWorkspaces: old.workspaceIds,
          status: "disconnected",
        });
      }
      // 不提前应用用户已有文件中的新条目；迁移之后由正常解析流程处理它们。
      await this.commitFile(target, disk.revision, document, records, [], true);
      // 迁移日志中的 document 包含旧文件，刷新仍逐项补全对应投影。
      const state = this.store.get("mcpFiles", "user");
      if (state)
        this.store.put("mcpFiles", { ...state, appliedHash: "migration" });
    });
  }
  private async recover(target: McpConfigTarget): Promise<void> {
    const state = this.store.get("mcpFiles", fileId(target));
    if (!state?.staged) return;
    const disk = await this.files.read(target);
    if (disk.text === state.staged.text)
      await this.finish(state, disk.revision);
    else {
      for (const ref of state.staged.newRefs) this.credentials.remove(ref);
      const { staged: _, ...previous } = state;
      this.store.put("mcpFiles", previous);
    }
  }
  private async finish(state: McpFileState, revision: string): Promise<void> {
    const stage = state.staged;
    if (!stage) return;
    const next = parseMcpDocument(stage.text);
    const previous = this.connections(state.target);
    // 更新投影先撤销旧版本的新派发资格；断开连接会使在途副作用进入现有 unknown 路径。
    for (const old of previous) {
      const replacement = stage.connections.find(
        (record) => record.id === old.id,
      );
      if (replacement?.revision === old.revision && !old.blocked) continue;
      this.store.put("connections", { ...old, blocked: true });
      await this.runtime.disconnect(old.id);
    }
    this.store.transaction(() => {
      for (const record of stage.connections)
        this.store.put("connections", record);
      this.store.put("mcpFiles", {
        id: state.id,
        target: state.target,
        appliedHash: revision,
        document: next,
      });
    });
    const retained = new Set(
      stage.connections
        .flatMap((c) => [
          c.credentialRef,
          c.oauthRef,
          ...Object.values(c.environmentRefs),
        ])
        .filter(Boolean),
    );
    for (const old of previous) {
      if (!stage.connections.some((c) => c.id === old.id))
        this.removals.set(old.id, await this.legacy.remove(old.id));
      else
        for (const ref of [
          old.credentialRef,
          old.oauthRef,
          ...Object.values(old.environmentRefs),
        ])
          if (ref && !retained.has(ref)) this.credentials.remove(ref);
    }
  }
  private async commitFile(
    target: McpConfigTarget,
    revision: string,
    document: McpConfigDocument,
    records: StoredMcpConnection[],
    refs: string[],
    write: boolean,
  ): Promise<void> {
    target = cleanTarget(target);
    const previous = this.store.get("mcpFiles", fileId(target));
    const text = write
      ? `${JSON.stringify(document, null, 2)}\n`
      : (await this.files.read(target)).text;
    const state: McpFileState = {
      id: fileId(target),
      target,
      appliedHash: previous?.appliedHash ?? "",
      document: previous?.document ?? empty(),
      staged: {
        text,
        previousRevision: revision,
        connections: records,
        newRefs: refs,
      },
    };
    this.store.put("mcpFiles", state);
    let changed = false;
    try {
      const newRevision = write
        ? await this.files.write(target, text, revision)
        : revision;
      changed = true;
      await this.finish(state, newRevision);
    } catch (error) {
      // 已落盘的新文件不能回滚成旧配置；保留日志，由下一次刷新或重启完成投影。
      if (!changed) {
        // rename 已成功但目录 fsync/响应失败时，必须保留秘密引用和提交日志供恢复。
        const disk = await this.files.read(target).catch(() => null);
        if (!disk || disk.text === text) throw error;
        for (const ref of refs) this.credentials.remove(ref);
        if (previous) this.store.put("mcpFiles", previous);
        else this.store.remove("mcpFiles", state.id);
      }
      throw error;
    }
  }
  private async apply(
    target: McpConfigTarget,
    revision: string,
    document: McpConfigDocument,
    write: boolean,
  ): Promise<void> {
    const safe = sanitizeMcpDocument(document).document;
    const records: StoredMcpConnection[] = [];
    const refs: string[] = [];
    try {
      for (const [key, config] of Object.entries(document.mcpServers)) {
        const input = mcpInput(key, config);
        const old = this.connections(target).find((c) => c.source?.key === key);
        const previousConfig = this.store.get("mcpFiles", fileId(target))
          ?.document.mcpServers[key];
        if (
          old &&
          !old.blocked &&
          canonical(previousConfig) === canonical(config)
        ) {
          records.push(old);
          continue;
        }
        // 逻辑引用只能取本条配置的原秘密；同名覆盖不能跨作用域继承凭证。
        const identityChanged =
          old &&
          (old.url !== (input.url ?? "") ||
            old.command !== (input.command ?? "") ||
            old.auth !== input.auth ||
            old.clientId !== (input.clientId ?? ""));
        const secret = (
          value: string,
          slot: string,
          previous: string | null,
        ): string => {
          if (value === secretSlot(slot)) {
            if (!previous || identityChanged)
              throw new AppError(
                "credential_required",
                "服务身份已改变或凭证缺失，请重新填写认证信息。",
              );
            return previous;
          }
          const ref = this.id();
          this.credentials.write(ref, value);
          refs.push(ref);
          return ref;
        };
        const environmentRefs = Object.fromEntries(
          Object.entries(config.env ?? {}).map(([name, value]) => [
            name,
            secret(value, `env.${name}`, old?.environmentRefs[name] ?? null),
          ]),
        );
        records.push({
          id: old?.id ?? this.id(),
          name: key,
          transport: input.transport,
          toolExposure: input.toolExposure ?? "deferred",
          command: input.command ?? "",
          args: input.args ?? [],
          url: input.url ?? "",
          auth: input.auth,
          clientId: input.clientId ?? "",
          clientMetadataUrl: input.clientMetadataUrl ?? "",
          environmentNames: Object.keys(environmentRefs),
          environmentRefs,
          credentialRef:
            input.auth === "token" && config.token
              ? secret(config.token, "token", old?.credentialRef ?? null)
              : null,
          oauthRef: identityChanged ? null : (old?.oauthRef ?? null),
          networkDomains: input.networkDomains ?? [],
          additionalPaths: input.additionalPaths ?? [],
          workspaceIds: old?.workspaceIds ?? [],
          ...(config.workspaceIds
            ? { allowedWorkspaces: config.workspaceIds }
            : {}),
          source: { ...cleanTarget(target), fileId: fileId(target), key },
          enabled: config.enabled !== false,
          blocked: false,
          revision: (old?.revision ?? -1) + 1,
          status: "disconnected",
          createdAt: old?.createdAt ?? new Date().toISOString(),
        });
      }
    } catch (error) {
      for (const ref of refs) this.credentials.remove(ref);
      throw error;
    }
    await this.commitFile(target, revision, safe, records, refs, write);
  }
  private async inspect(target: McpConfigTarget): Promise<McpConfigView> {
    target = cleanTarget(target);
    const disk = await this.files.read(target);
    const state = this.store.get("mcpFiles", fileId(target));
    try {
      const parsed = parseMcpDocument(disk.text);
      const safe = sanitizeMcpDocument(parsed);
      return {
        target,
        path: disk.path,
        revision: disk.revision,
        document: safe.document,
        containsSecrets: safe.containsSecrets,
        error: null,
        pending:
          safe.containsSecrets ||
          (target.scope === "project" &&
            Boolean(disk.text || state) &&
            state?.appliedHash !== disk.revision &&
            canonical(state?.document ?? empty()) !== canonical(parsed)),
        appliedDocument: state?.document ?? null,
      };
    } catch (error) {
      return {
        target,
        path: disk.path,
        revision: disk.revision,
        document: null,
        containsSecrets: false,
        error:
          error instanceof AppError ? error.message : "无法解析 MCP 配置。",
        pending: target.scope === "project",
        appliedDocument: state?.document ?? null,
      };
    }
  }
  private async reconcile(target: McpConfigTarget): Promise<McpConfigView> {
    await this.recover(target);
    let view = await this.inspect(target);
    if (view.pending) {
      for (const record of this.connections(target))
        if (
          !record.blocked &&
          (!view.document ||
            view.containsSecrets ||
            canonical(view.document.mcpServers[record.source?.key ?? ""]) !==
              canonical(
                view.appliedDocument?.mcpServers[record.source?.key ?? ""],
              ))
        ) {
          this.store.put("connections", { ...record, blocked: true });
          await this.runtime.disconnect(record.id);
        }
    } else if (
      !view.error &&
      view.document &&
      (this.store.get("mcpFiles", fileId(target))?.appliedHash !==
        view.revision ||
        Object.keys(view.document.mcpServers).some(
          (key) => !this.connections(target).some((c) => c.source?.key === key),
        ))
    ) {
      // 外部用户级文件自动采用；项目级只有无配置的空文件允许直接初始化。
      try {
        await this.apply(target, view.revision, view.document, false);
      } catch (error) {
        view = {
          ...view,
          error: error instanceof AppError ? error.message : "配置应用失败。",
        };
      }
    }
    return view;
  }
  async config(target: McpConfigTarget): Promise<McpConfigView> {
    return this.serial(() => this.reconcile(target));
  }
  async save(input: McpConfigSave): Promise<McpConfigView> {
    await this.serial(async () => {
      const document = parseMcpDocument(JSON.stringify(input.document));
      if (
        sanitizeMcpDocument(document).containsSecrets &&
        !input.convertSecrets
      )
        throw new AppError(
          "secret_conversion_required",
          "配置包含明文凭证，请确认转换为安全引用后保存。",
          409,
        );
      const disk = await this.files.read(input);
      if (disk.revision !== input.expectedRevision)
        throw new AppError(
          "revision_conflict",
          "配置文件已变化，请刷新后重试。",
          409,
        );
      await this.apply(input, disk.revision, document, true);
    });
    await this.refresh();
    return this.config(input);
  }
  async confirm(input: McpConfigConfirmation): Promise<McpConfigView> {
    await this.serial(async () => {
      const disk = await this.files.read(input);
      if (disk.revision !== input.expectedRevision)
        throw new AppError(
          "revision_conflict",
          "待确认的配置已变化，请重新查看。",
          409,
        );
      const document = parseMcpDocument(disk.text);
      const safe = sanitizeMcpDocument(document);
      if (safe.containsSecrets && !input.convertSecrets)
        throw new AppError(
          "secret_conversion_required",
          "需要确认将明文凭证转换为安全引用。",
          409,
        );
      await this.apply(input, disk.revision, document, safe.containsSecrets);
    });
    await this.refresh();
    return this.config(input);
  }
  private track(task: Promise<unknown>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
  }
  async activate(workspace: Workspace, wait = true): Promise<McpConfigView[]> {
    this.contexts.set(workspace.id, workspace);
    const views = await this.serial(async () => {
      const user = await this.reconcile({ scope: "user" });
      const project =
        workspace.kind === "diagnostic"
          ? null
          : await this.reconcile({
              scope: "project",
              workspaceId: workspace.id,
            });
      const overrides = new Set([
        ...Object.keys(project?.document?.mcpServers ?? {}),
        ...(project?.pending
          ? Object.keys(project.appliedDocument?.mcpServers ?? {})
          : []),
      ]);
      for (const connection of this.store.list("connections")) {
        if (!connection.source) continue;
        const visible =
          connection.source.scope === "user"
            ? !overrides.has(connection.source.key)
            : connection.source.workspaceId === workspace.id;
        const enabled =
          visible &&
          !connection.blocked &&
          connection.enabled !== false &&
          (!connection.allowedWorkspaces ||
            connection.allowedWorkspaces.includes(workspace.id));
        const included = connection.workspaceIds.includes(workspace.id);
        if (included !== enabled) {
          this.store.put("connections", {
            ...connection,
            workspaceIds: enabled
              ? [...connection.workspaceIds, workspace.id]
              : connection.workspaceIds.filter((id) => id !== workspace.id),
          });
          if (!enabled)
            await this.runtime.disconnect(connection.id, workspace.id);
        }
      }
      return project ? [user, project] : [user];
    });
    const jobs: Promise<unknown>[] = [];
    if (!this.stopped)
      for (const connection of this.store.list("connections")) {
        if (
          !connection.source ||
          !connection.workspaceIds.includes(workspace.id) ||
          connection.enabled === false ||
          connection.blocked
        )
          continue;
        const key = `${connection.id}:${connection.revision}:${workspace.id}`;
        if (
          this.attempted.has(key) &&
          !(
            wait &&
            this.runtime.state(connection.id, workspace.id).status ===
              "connecting"
          )
        )
          continue;
        this.attempted.add(key);
        const job = this.runtime
          .connect(connection.id, workspace.id)
          .catch(() => {});
        this.track(job);
        jobs.push(job);
      }
    if (wait) await Promise.all(jobs);
    return views;
  }
  async overview(workspaceId?: string): Promise<McpOverview> {
    const workspace = workspaceId
      ? this.store.get("workspaces", workspaceId)
      : await this.projects.diagnostic();
    if (!workspace)
      throw new AppError("workspace_required", "指定项目不存在。", 404);
    const configs = await this.activate(workspace, false);
    const overrides = new Set(
      Object.keys(
        configs.find((c) => c.target.scope === "project")?.document
          ?.mcpServers ?? {},
      ),
    );
    return {
      workspace,
      diagnostic: workspace.kind === "diagnostic",
      configs,
      servers: [
        ...configs.flatMap((view) =>
          Object.entries(
            (view.document ?? view.appliedDocument ?? empty()).mcpServers,
          ).map(([name, config]) => {
            const record = this.connections(view.target).find(
              (c) => c.source?.key === name,
            );
            const overridden =
              view.target.scope === "user" && overrides.has(name);
            const live = record
              ? this.runtime.state(record.id, workspace.id)
              : { status: "disconnected" as const, error: null, tools: [] };
            return {
              ...live,
              id: record?.id ?? `${fileId(view.target)}:${name}`,
              name,
              scope: view.target.scope,
              workspaceId: view.target.workspaceId ?? null,
              enabled: config.enabled !== false,
              overridden,
              config,
              status: view.pending
                ? ("pending" as const)
                : config.enabled === false || overridden
                  ? ("disabled" as const)
                  : live.status,
            };
          }),
        ),
        ...(this.pluginOverview?.(workspace.id) ?? []),
      ],
    };
  }
  /** 旧 HTTP 配置入口也写入文件，避免升级后出现第二个可写配置事实源。 */
  async saveConnection(
    input: McpConnectionInput,
    id?: string,
  ): Promise<McpConnection> {
    const old = id ? this.store.get("connections", id) : null;
    if (old?.plugin)
      throw new AppError("plugin_managed", "请在插件管理中修改此连接。", 409);
    if (id && !old) throw new AppError("not_found", "MCP 连接不存在。", 404);
    if (old && old.revision !== input.expectedRevision)
      throw new AppError("revision_conflict", "MCP 连接已经变化。", 409);
    const target = old?.source
      ? cleanTarget(old.source)
      : { scope: "user" as const };
    const view = await this.config(target);
    if (!view.document || view.pending || view.error)
      throw new AppError("config_pending", "请先确认或修复配置文件。", 409);
    const previous = view.document.mcpServers[old?.source?.key ?? input.name];
    if (old?.source && old.source.key !== input.name)
      delete view.document.mcpServers[old.source.key];
    const { name, environment, expectedRevision: _, token, ...rest } = input;
    view.document.mcpServers[name] = {
      ...rest,
      // 旧客户端编辑连接时省略新字段，保留用户已选择的方式；文件中主动省略则默认按需。
      toolExposure: input.toolExposure ?? previous?.toolExposure ?? "deferred",
      ...(environment !== undefined
        ? { env: environment }
        : previous?.env
          ? { env: previous.env }
          : {}),
      ...(token !== undefined
        ? { token }
        : previous?.token
          ? { token: previous.token }
          : {}),
    };
    await this.save({
      ...target,
      expectedRevision: view.revision,
      document: view.document,
      convertSecrets: true,
    });
    const record = this.connections(target).find((c) => c.source?.key === name);
    const result = this.legacy.list().find((c) => c.id === record?.id);
    if (!result)
      throw new AppError("config_write", "配置保存后未找到连接记录。");
    return result;
  }
  async removeConnection(id: string): Promise<McpRemoval> {
    const old = this.store.get("connections", id);
    if (old?.plugin)
      throw new AppError("plugin_managed", "请在插件管理中移除此连接。", 409);
    if (!old?.source) return this.legacy.remove(id);
    const view = await this.config(old.source);
    if (!view.document || view.pending || view.error)
      throw new AppError("config_pending", "请先确认或修复配置文件。", 409);
    delete view.document.mcpServers[old.source.key];
    await this.save({
      ...cleanTarget(old.source),
      expectedRevision: view.revision,
      document: view.document,
    });
    const result = this.removals.get(id) ?? {
      localRemoved: true as const,
      remoteRevocation: "not_applicable" as const,
    };
    this.removals.delete(id);
    return result;
  }
  async reconnect(id: string, workspaceId: string): Promise<McpLiveState> {
    const workspace = this.store.get("workspaces", workspaceId);
    if (!workspace) throw new AppError("workspace_required", "项目不存在。");
    await this.activate(workspace, false);
    await this.runtime.disconnect(id, workspaceId);
    await this.runtime.connect(id, workspaceId).catch(() => {});
    return this.runtime.state(id, workspaceId);
  }
  async guard(_id: string, workspaceId: string): Promise<void> {
    const workspace = this.store.get("workspaces", workspaceId);
    if (!workspace || workspace.kind === "diagnostic")
      throw new AppError("mcp_unavailable", "连接检测环境不能调用业务工具。");
    await this.activate(workspace, false);
  }
  async refresh(): Promise<void> {
    for (const workspace of this.contexts.values()) {
      if (this.stopped) return;
      await this.activate(workspace, false);
      for (const connection of this.store.list("connections"))
        if (connection.workspaceIds.includes(workspace.id))
          await this.runtime.probe?.(connection.id, workspace.id);
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.tail.catch(() => {});
    await Promise.allSettled([...this.tasks]);
  }
}
