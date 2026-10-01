/**
 * MCP 配置用例：管理连接版本与工作区启用范围，将 Token 和环境变量值交给凭证仓储。
 * 保存配置不会启动外部程序；用户明确连接后才调用适配器，变更前关闭旧连接。
 */
import {
  AppError,
  type McpConnection,
  type McpConnectionInput,
  type McpRemoval,
} from "@myagent/contracts";
import type {
  CredentialStore,
  ExecutionStore,
  StoredMcpConnection,
} from "@myagent/state";

export interface McpManagementPort {
  connect(
    id: string,
    workspaceId: string,
  ): Promise<{ ok: boolean; tools: number; authorizationUrl?: string }>;
  disconnect(id: string): Promise<void>;
  revokeCredentials?(
    connection: StoredMcpConnection,
  ): Promise<McpRemoval["remoteRevocation"]>;
}
function publicConnection(connection: StoredMcpConnection): McpConnection {
  const {
    credentialRef: _,
    environmentRefs: __,
    oauthRef: ___,
    ...data
  } = connection;
  return { ...data, toolExposure: data.toolExposure ?? "deferred" };
}
export class McpSettingsService {
  constructor(
    private readonly store: ExecutionStore,
    private readonly credentials: CredentialStore,
    private readonly runtime: McpManagementPort,
    private readonly id: () => string,
  ) {}
  list(): McpConnection[] {
    return this.store.list("connections").map(publicConnection);
  }
  async save(input: McpConnectionInput, id?: string): Promise<McpConnection> {
    const old = id ? this.store.get("connections", id) : null;
    if (id && !old) throw new AppError("not_found", "MCP 连接不存在。", 404);
    if (old && old.revision !== input.expectedRevision)
      throw new AppError(
        "revision_conflict",
        "MCP 连接已更新，请刷新后重试。",
        409,
      );
    validateMcpInput(input);
    for (const workspaceId of input.workspaceIds)
      if (!this.store.get("workspaces", workspaceId))
        throw new AppError("invalid_workspace", "启用范围包含不存在的工作区。");
    const environment = input.environment;
    if (old) await this.runtime.disconnect(old.id);
    const newRefs: string[] = [];
    const writeSecret = (value: string): string => {
      const ref = this.id();
      this.credentials.write(ref, value);
      newRefs.push(ref);
      return ref;
    };
    let committed = false;
    try {
      const environmentRefs = environment
        ? Object.fromEntries(
            Object.entries(environment).map(([key, value]) => [
              key,
              writeSecret(value),
            ]),
          )
        : (old?.environmentRefs ?? {});
      const connection: StoredMcpConnection = {
        id: old?.id ?? this.id(),
        name: input.name.trim(),
        transport: input.transport,
        toolExposure: input.toolExposure ?? old?.toolExposure ?? "deferred",
        command: input.command ?? "",
        args: input.args ?? [],
        networkDomains: input.networkDomains ?? [],
        additionalPaths: input.additionalPaths ?? [],
        url: input.url ?? "",
        workspaceIds: [...new Set(input.workspaceIds)],
        environmentNames: Object.keys(environmentRefs),
        environmentRefs,
        auth: input.auth,
        clientId: input.clientId ?? "",
        clientMetadataUrl: input.clientMetadataUrl ?? "",
        credentialRef:
          input.auth === "token"
            ? input.token !== undefined
              ? writeSecret(input.token)
              : (old?.credentialRef ?? null)
            : null,
        oauthRef: old?.oauthRef ?? null,
        status: "disconnected",
        revision: (old?.revision ?? -1) + 1,
        createdAt: old?.createdAt ?? new Date().toISOString(),
      };
      if (
        old &&
        (old.url !== connection.url ||
          old.auth !== connection.auth ||
          old.clientId !== connection.clientId)
      )
        connection.oauthRef = null;
      this.store.transaction(() => {
        if (
          old &&
          this.store.get("connections", old.id)?.revision !== old.revision
        )
          throw new AppError(
            "revision_conflict",
            "MCP 配置在保存期间已更新。",
            409,
          );
        this.store.put("connections", connection);
      });
      committed = true;
      if (old) {
        const keep = new Set([
          connection.credentialRef,
          connection.oauthRef,
          ...Object.values(connection.environmentRefs),
        ]);
        for (const ref of [
          old.credentialRef,
          old.oauthRef,
          ...Object.values(old.environmentRefs),
        ])
          if (ref && !keep.has(ref)) this.credentials.remove(ref);
      }
      return publicConnection(connection);
    } catch (error) {
      if (!committed) for (const ref of newRefs) this.credentials.remove(ref);
      throw error;
    }
  }
  connect(id: string, workspaceId: string) {
    return this.runtime.connect(id, workspaceId);
  }
  async remove(id: string): Promise<McpRemoval> {
    const connection = this.store.get("connections", id);
    if (!connection)
      return { localRemoved: true, remoteRevocation: "not_applicable" };
    await this.runtime.disconnect(id);
    const remoteRevocation =
      (await this.runtime.revokeCredentials?.(connection)) ?? "unsupported";
    for (const ref of [
      connection.credentialRef,
      connection.oauthRef,
      ...Object.values(connection.environmentRefs),
    ])
      if (ref) this.credentials.remove(ref);
    this.store.remove("connections", id);
    return { localRemoved: true, remoteRevocation };
  }
}

/** 所有配置入口共享最终业务校验；校验阶段不得关闭连接或改写凭证。 */
export function validateMcpInput(input: McpConnectionInput): void {
  // 文件配置与旧 HTTP 接口共用校验，未知值不得悄悄降级或被当成直接提供。
  if (
    input.toolExposure !== undefined &&
    input.toolExposure !== "deferred" &&
    input.toolExposure !== "direct"
  )
    throw new AppError(
      "invalid_mcp",
      "工具提供方式只能是 deferred 或 direct。",
    );
  if (!input.name.trim() || input.name.length > 100)
    throw new AppError("invalid_mcp", "MCP 名称需要 1–100 字符。");
  if (input.transport === "stdio" && !input.command?.trim())
    throw new AppError("invalid_mcp", "stdio 需要可执行命令。");
  if (input.transport === "stdio" && input.auth === "oauth")
    throw new AppError(
      "invalid_mcp",
      "OAuth 用于 HTTP MCP；stdio 凭证通过独立环境变量配置。",
    );
  if (input.transport === "http") {
    let url: URL;
    try {
      url = new URL(input.url ?? "");
    } catch {
      throw new AppError("invalid_mcp", "请填写有效 MCP HTTP 地址。");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new AppError(
        "invalid_mcp",
        "MCP 地址不能包含凭证、查询参数或片段。",
      );
  }
  if (input.clientMetadataUrl)
    try {
      if (new URL(input.clientMetadataUrl).protocol !== "https:")
        throw new Error();
    } catch {
      throw new AppError(
        "invalid_mcp",
        "OAuth 客户端元数据地址必须使用有效 HTTPS 地址。",
      );
    }
  const environment = input.environment;
  if (environment)
    for (const [name, value] of Object.entries(environment)) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        /^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|PATH|HOME|TMPDIR|ENV|BASH_ENV|SHELL|.*PROXY)$/i.test(
          name,
        )
      )
        throw new AppError(
          "invalid_environment",
          "不允许覆盖执行加载器、基础路径或代理环境变量。",
        );
      if (value.length > 8192 || value.includes("\0"))
        throw new AppError("invalid_environment", "环境变量值无效或过长。");
    }
}
