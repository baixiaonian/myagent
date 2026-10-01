/**
 * MCP 双传输适配：HTTP 使用官方 Client，stdio 经独立 Worker，按用户选择使用沙箱或完全访问模式。
 * 目录只注册协议定义；权限不来自远端 annotations，工具业务请求不自动重试。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  AppError,
  type JsonValue,
  type McpLiveState,
  type McpRemoval,
  type ToolDescriptor,
  type WorkerConfiguration,
} from "@myagent/contracts";
import { type DispatchRequest, raceSignal } from "@myagent/kernel";
import type {
  CredentialStore,
  ExecutionStore,
  StoredMcpConnection,
} from "@myagent/state";
import { WorkerClient } from "../execution/gateway.js";
import { digest } from "../execution/paths.js";
import type { ToolRegistry } from "../execution/registry.js";
import { mcpFetch } from "./http.js";
import { McpOAuthProvider } from "./oauth.js";

interface ConnectionClient {
  executionMode: import("@myagent/contracts").ExecutionMode;
  connection: StoredMcpConnection;
  workspaceId: string;
  client: Client | null;
  transport: StreamableHTTPClientTransport | null;
  oauth: McpOAuthProvider | null;
  worker: WorkerClient | null;
  configuration: WorkerConfiguration | null;
  abort: AbortController;
}
export interface McpRuntimeOptions {
  observer?: import("@myagent/observability").ObserverPort;
  store: ExecutionStore;
  credentials: CredentialStore;
  registry: ToolRegistry;
  dataDir: string;
  runtimeRoot: string;
  callbackUrl: () => string;
}
export class McpRuntime {
  private readonly states = new Map<string, McpLiveState>();
  private readonly probed = new Map<string, number>();
  async probe(id: string, workspaceId: string): Promise<void> {
    const connection = this.options.store.get("connections", id);
    if (!connection) return;
    const key = this.key(connection, workspaceId);
    const record = this.clients.get(key);
    if (
      !record ||
      this.states.get(key)?.status !== "connected" ||
      Date.now() - (this.probed.get(key) ?? 0) < 15000
    )
      return;
    this.probed.set(key, Date.now());
    try {
      await this.discover(record);
    } catch {
      await this.disconnect(id, workspaceId, "standard");
      this.states.set(key, {
        status: "error",
        tools: [],
        error: "连接检测失败，请重新连接。",
      });
    }
  }
  beforeCall?: (
    id: string,
    workspaceId: string,
    runId?: string,
  ) => Promise<void>;
  state(
    id: string,
    workspaceId: string,
    executionMode: import("@myagent/contracts").ExecutionMode = "standard",
  ): McpLiveState {
    const connection = this.options.store.get("connections", id);
    return structuredClone(
      connection
        ? (this.states.get(
            this.key(connection, workspaceId, executionMode),
          ) ?? {
            status: "disconnected",
            tools: [],
            error: null,
          })
        : { status: "disconnected", tools: [], error: null },
    );
  }
  private readonly clients = new Map<string, ConnectionClient>();
  private readonly connecting = new Map<
    string,
    Promise<{ ok: boolean; tools: number; authorizationUrl?: string }>
  >();
  constructor(private readonly options: McpRuntimeOptions) {}
  private key(
    connection: StoredMcpConnection,
    workspaceId: string,
    executionMode: import("@myagent/contracts").ExecutionMode = "standard",
  ): string {
    return `${connection.id}:${connection.revision}:${workspaceId}:${executionMode}`;
  }
  connect(
    id: string,
    workspaceId: string,
    executionMode: import("@myagent/contracts").ExecutionMode = "standard",
  ): Promise<{ ok: boolean; tools: number; authorizationUrl?: string }> {
    const connection = this.options.store.get("connections", id);
    if (
      !connection?.workspaceIds.includes(workspaceId) ||
      connection.enabled === false ||
      connection.blocked
    )
      throw new AppError("mcp_disabled", "此工作区未启用该 MCP 连接。", 403);
    const key = this.key(connection, workspaceId, executionMode);
    if (
      this.states.get(key)?.status === "connected" &&
      this.clients.has(key) &&
      this.clients.get(key)?.worker?.alive !== false
    )
      return Promise.resolve({
        ok: true,
        tools: this.states.get(key)?.tools.length ?? 0,
      });
    const pending = this.connecting.get(key);
    if (pending) return pending;
    const scope = { jobId: randomUUID() };
    const span = this.options.observer?.span(scope, "mcp.handshake", {
      connectionId: connection.id,
      version: connection.revision,
      workspaceId,
    });
    const operation = this.open(connection, workspaceId, executionMode)
      .then(
        (result) => {
          span?.end(result.ok ? "succeeded" : "failed", {
            toolCount: result.tools,
          });
          return result;
        },
        (error) => {
          span?.end("failed");
          throw error;
        },
      )
      .finally(() => {
        this.connecting.delete(key);
        this.options.observer?.endScope?.(scope, "completed");
      });
    this.connecting.set(key, operation);
    return operation;
  }
  private async open(
    connection: StoredMcpConnection,
    workspaceId: string,
    executionMode: import("@myagent/contracts").ExecutionMode,
  ): Promise<{ ok: boolean; tools: number; authorizationUrl?: string }> {
    const key = this.key(connection, workspaceId, executionMode);
    const existing = this.clients.get(key);
    if (existing && (existing.client || existing.worker))
      try {
        return { ok: true, tools: await this.discover(existing) };
      } catch {
        await this.disconnect(connection.id, workspaceId, executionMode);
      }
    const record: ConnectionClient = {
      executionMode,
      connection,
      workspaceId,
      client: null,
      transport: null,
      oauth: null,
      worker: null,
      configuration: null,
      abort: new AbortController(),
    };
    this.clients.set(key, record);
    this.states.set(key, { status: "connecting", tools: [], error: null });
    try {
      if (connection.transport === "http") {
        if (connection.auth === "oauth")
          record.oauth = new McpOAuthProvider(
            connection,
            this.options.credentials,
            this.options.store,
            this.options.callbackUrl(),
          );
        const token = connection.credentialRef
          ? this.options.credentials.read(connection.credentialRef)
          : null;
        record.transport = new StreamableHTTPClientTransport(
          new URL(connection.url),
          {
            ...(record.oauth ? { authProvider: record.oauth } : {}),
            requestInit: {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
              redirect: "manual",
            },
            fetch: mcpFetch(connection.url),
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          },
        );
        record.client = new Client(
          { name: "myagent", version: "0.2.0" },
          { capabilities: {} },
        );
        record.client.setNotificationHandler(
          ToolListChangedNotificationSchema,
          async () => {
            try {
              await this.discover(record);
            } catch {
              connection.status = "error";
              this.states.set(key, {
                status: "error",
                tools: [],
                error: "工具目录更新失败，请重新连接。",
              });
              this.options.registry.removeConnection(
                connection.id,
                workspaceId,
                executionMode,
              );
            }
          },
        );
        // SDK 的 sessionId getter 与其 Transport 可选字段在 exactOptionalPropertyTypes 下声明不一致。
        record.client.onclose = () => {
          if (
            this.clients.get(key) !== record ||
            record.oauth?.authorizationUrl
          )
            return;
          record.abort.abort();
          this.clients.delete(key);
          this.options.registry.removeConnection(
            connection.id,
            workspaceId,
            executionMode,
          );
          this.states.set(key, {
            status: "disconnected",
            tools: [],
            error: "服务连接已关闭。",
          });
        };
        await record.client.connect(record.transport as Transport, {
          timeout: 15000,
        });
      } else {
        const workspace = this.options.store.get("workspaces", workspaceId);
        if (!workspace)
          throw new AppError("workspace_required", "MCP 需要有效工作区。");
        const prepared = await this.options.registry.prepare(
          "exec_command",
          JSON.stringify({
            command: connection.command,
            cwd: workspace.path,
            additionalPaths: connection.additionalPaths,
            networkDomains: connection.networkDomains,
          }),
          {
            executionMode,
            runId: "mcp-connect",
            sessionId: "",
            stepId: "",
            invocationId: "",
            workspace,
          },
        );
        const scratchDir = await realpath(
          await mkdtemp(join(tmpdir(), "myagent-mcp-")),
        );
        const workerId = randomUUID();
        const recordDir = join(this.options.dataDir, "execution", workerId);
        await mkdir(recordDir, { recursive: true, mode: 0o700 });
        record.configuration = {
          executionMode,
          ...(connection.pluginReadOnlyPaths
            ? { readOnlyPaths: connection.pluginReadOnlyPaths }
            : {}),
          workerId,
          workspace,
          resources: [
            { kind: "path", target: workspace.path, access: "write" },
            ...prepared.resources,
          ],
          protectedPaths: [
            this.options.dataDir,
            join(this.options.runtimeRoot, ".env"),
          ],
          userHome: homedir(),
          runtimeRoot: this.options.runtimeRoot,
          actionPath: fileURLToPath(
            new URL("../../../../apps/worker/dist/action.js", import.meta.url),
          ),
          recordDir,
          scratchDir,
        };
        record.worker = new WorkerClient(
          fileURLToPath(
            new URL("../../../../apps/worker/dist/main.js", import.meta.url),
          ),
          scratchDir,
          (event) => {
            if (event.type === "mcp_catalog_changed")
              void this.discover(record).catch(() => {
                /* 目录不可用时拒绝旧版本调用，用户可以重新连接。 */
              });
          },
        );
        await record.worker.request(
          { method: "initialize", configuration: record.configuration },
          15000,
        );
        const environment: Record<string, string> = {};
        for (const [name, ref] of Object.entries(connection.environmentRefs)) {
          const value = this.options.credentials.read(ref);
          if (value !== null) environment[name] = value;
        }
        await record.worker.request(
          {
            method: "mcp_connect",
            command: connection.command,
            args: connection.args,
            environment,
          },
          20000,
        );
      }
      const count = await this.discover(record);
      return { ok: true, tools: count };
    } catch (error) {
      const url = record.oauth?.authorizationUrl;
      if (url) {
        this.states.set(key, {
          status: "authorization_required",
          tools: [],
          error: null,
          authorizationUrl: url,
        });
        return { ok: false, tools: 0, authorizationUrl: url };
      }
      await this.disconnect(connection.id, workspaceId, executionMode);
      this.states.set(key, {
        status: "error",
        tools: [],
        error: "MCP 连接失败，请检查地址、认证和沙箱权限。",
      });
      throw error instanceof AppError
        ? error
        : new AppError(
            "mcp_connection",
            "MCP 连接失败，请检查地址、认证和沙箱权限。",
          );
    }
  }
  private async discover(record: ConnectionClient): Promise<number> {
    const scope = { jobId: randomUUID() };
    const span = this.options.observer?.span(scope, "mcp.discovery", {
      connectionId: record.connection.id,
      workspaceId: record.workspaceId,
      version: record.connection.revision,
    });
    let outcome = "succeeded";
    try {
      let values: JsonValue[] = [];
      if (record.worker) {
        const response = await record.worker.request(
          { method: "mcp_list" },
          20000,
        );
        if (Array.isArray(response.data)) values = response.data;
      } else if (record.client) {
        let cursor: string | undefined;
        do {
          const page = await record.client.listTools(cursor ? { cursor } : {});
          values.push(
            ...(JSON.parse(JSON.stringify(page.tools)) as JsonValue[]),
          );
          cursor = page.nextCursor;
          if (
            values.length > 5000 ||
            JSON.stringify(values).length > 5 * 1024 * 1024
          )
            throw new AppError("mcp_catalog_limit", "MCP 工具目录超过限制。");
        } while (cursor);
      }
      if (
        this.options.store.get("connections", record.connection.id)
          ?.revision !== record.connection.revision ||
        !this.clients.has(
          this.key(record.connection, record.workspaceId, record.executionMode),
        )
      )
        throw new AppError("mcp_changed", "MCP 目录已失效。");
      const descriptors: ToolDescriptor[] = [];
      for (const value of values) {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          typeof value.name !== "string" ||
          !value.inputSchema ||
          typeof value.inputSchema !== "object" ||
          Array.isArray(value.inputSchema)
        )
          throw new AppError("mcp_catalog_invalid", "MCP 返回无效工具定义。");
        const name = `mcp_${digest(`${record.connection.id}:${record.workspaceId}${record.executionMode === "full_access" ? ":full_access" : ""}`).slice(0, 8)}_${digest(value.name).slice(0, 8)}_${value.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 30)}`;
        descriptors.push({
          name,
          description: `[${record.connection.name}] ${String(value.description ?? value.name)}`,
          parameters: value.inputSchema,
          version: digest(
            JSON.stringify([
              record.connection.id,
              record.connection.revision,
              value,
            ]),
          ),
          source: {
            kind: "mcp",
            connectionId: record.connection.id,
            originalName: value.name,
            executionMode: record.executionMode,
            workspaceId: record.workspaceId,
          },
          effects: "unknown",
          concurrency: "exclusive",
          requiresWorkspace: true,
        });
      }
      // 完整取得新目录后替换，调用仍需通过模型请求时保存的版本检查。
      this.options.registry.replaceConnection(
        record.connection.id,
        descriptors,
        record.workspaceId,
        record.executionMode,
      );
      this.states.set(
        this.key(record.connection, record.workspaceId, record.executionMode),
        {
          status: "connected",
          error: null,
          tools: descriptors.map((d) => ({
            name: d.source.kind === "mcp" ? d.source.originalName : d.name,
            description: d.description,
            parameters: d.parameters,
          })),
        },
      );
      span?.end("succeeded", { toolCount: descriptors.length });
      return descriptors.length;
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      span?.end(outcome);
      this.options.observer?.endScope?.(scope, outcome);
    }
  }
  async call(
    request: DispatchRequest,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const span = this.options.observer?.span(
      {
        runId: request.context.runId,
        sessionId: request.context.sessionId,
        invocationId: request.context.invocationId,
        attemptId: request.attemptId,
      },
      "mcp.call",
      { "gen_ai.tool.name": request.prepared.descriptor.name },
    );
    let outcome = "succeeded";
    try {
      const source = request.prepared.descriptor.source;
      if (source.kind !== "mcp" || !request.context.workspace)
        throw new AppError("mcp_unavailable", "MCP 调用缺少来源或工作区。");
      await this.beforeCall?.(
        source.connectionId,
        request.context.workspace.id,
        request.context.runId,
      );
      const connection = this.options.store.get(
        "connections",
        source.connectionId,
      );
      if (
        connection?.blocked ||
        connection?.enabled === false ||
        !connection?.workspaceIds.includes(request.context.workspace.id)
      )
        throw new AppError("mcp_disabled", "MCP 配置已停用或等待确认。");
      if (
        request.prepared.descriptor.version !==
        this.options.registry
          .descriptors()
          .find((d) => d.name === request.prepared.descriptor.name)?.version
      )
        throw new AppError(
          "mcp_changed",
          "工具配置已变化，请重新获取工具目录。",
          409,
        );
      if (!connection)
        throw new AppError("mcp_unavailable", "MCP 连接已删除。");
      const record = this.clients.get(
        this.key(
          connection,
          request.context.workspace.id,
          request.context.executionMode,
        ),
      );
      if (!record)
        throw new AppError(
          "mcp_disconnected",
          "MCP 连接已断开，请在设置中重新连接。",
        );
      signal = AbortSignal.any([signal, record.abort.signal]);
      let value: JsonValue;
      if (record.worker) {
        await request.onAccepted?.(record.configuration?.workerId ?? null);
        const abort = () => {
          void record.worker
            ?.request({ method: "cancel", attemptId: request.attemptId }, 7000)
            .catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          const response = await raceSignal(
            record.worker.request(
              {
                method: "mcp_call",
                execution: {
                  attemptId: request.attemptId,
                  invocationId: request.context.invocationId,
                  runId: request.context.runId,
                  sessionId: request.context.sessionId,
                  name: source.originalName,
                  arguments: request.prepared.arguments,
                  resources: request.authorizedResources,
                  timeoutMs: request.timeoutMs,
                },
              },
              request.timeoutMs + 8000,
            ),
            signal,
          );
          if (!response.receipt)
            throw new AppError("mcp_protocol", "MCP Worker 未返回回执。");
          value = response.receipt.data;
        } finally {
          signal.removeEventListener("abort", abort);
        }
      } else {
        if (!record.client)
          throw new AppError("mcp_disconnected", "MCP 连接不可用。");
        await request.onAccepted?.(null);
        const result = await raceSignal(
          record.client.callTool(
            {
              name: source.originalName,
              arguments: request.prepared.arguments,
            },
            undefined,
            { signal, timeout: request.timeoutMs },
          ),
          signal,
        );
        value = JSON.parse(JSON.stringify(result)) as JsonValue;
      }
      return this.redact(connection, value);
    } catch (error) {
      outcome = signal.aborted ? "cancelled" : "failed";
      throw error;
    } finally {
      span?.end(outcome);
    }
  }
  private redact(connection: StoredMcpConnection, value: JsonValue): JsonValue {
    const secrets = Object.values(connection.environmentRefs)
      .map((ref) => this.options.credentials.read(ref))
      .filter((value): value is string => Boolean(value));
    if (connection.credentialRef) {
      const token = this.options.credentials.read(connection.credentialRef);
      if (token) secrets.push(token);
    }
    if (connection.oauthRef) {
      const raw = this.options.credentials.read(connection.oauthRef);
      if (raw)
        try {
          const record = JSON.parse(raw) as {
            tokens?: { access_token?: string; refresh_token?: string };
            client?: { client_secret?: string };
          };
          for (const value of [
            record.tokens?.access_token,
            record.tokens?.refresh_token,
            record.client?.client_secret,
          ])
            if (value) secrets.push(value);
        } catch {
          /* 损坏凭证在连接时拒绝；不能将解析错误或原始值送给模型。 */
        }
    }
    const visit = (item: JsonValue): JsonValue =>
      typeof item === "string"
        ? secrets.reduce(
            (text, secret) => text.replaceAll(secret, "[已隐藏凭证]"),
            item,
          )
        : Array.isArray(item)
          ? item.map(visit)
          : item && typeof item === "object"
            ? Object.fromEntries(
                Object.entries(item).map(([key, value]) => [key, visit(value)]),
              )
            : item;
    return visit(value);
  }
  async finishAuth(state: string, code: string): Promise<void> {
    for (const record of this.clients.values())
      if (record.oauth?.accepts(state) && record.transport) {
        record.oauth.consumeState(state);
        await record.transport.finishAuth(code);
        const id = record.connection.id;
        const workspaceId = record.workspaceId;
        await this.disconnect(id, workspaceId);
        await this.connect(id, workspaceId);
        return;
      }
    throw new AppError(
      "oauth_state",
      "OAuth 回调无效或已过期，请重新连接。",
      400,
    );
  }
  async disconnect(
    id: string,
    workspaceId?: string,
    executionMode?: import("@myagent/contracts").ExecutionMode,
  ): Promise<void> {
    for (const [key, record] of this.clients)
      if (
        record.connection.id === id &&
        (!workspaceId || record.workspaceId === workspaceId) &&
        (!executionMode || record.executionMode === executionMode)
      ) {
        this.clients.delete(key);
        record.abort.abort(
          new AppError("mcp_changed", "MCP 配置改变，已停止旧连接。"),
        );
        this.states.set(key, {
          status: "disconnected",
          tools: [],
          error: null,
        });
        await record.client?.close();
        const confirmed = record.worker ? await record.worker.close() : true;
        if (record.configuration && confirmed)
          await rm(record.configuration.scratchDir, {
            recursive: true,
            force: true,
          });
      }
    this.options.registry.removeConnection(id, workspaceId, executionMode);
  }
  /** 本机删除不伪装成服务端撤销；仅向发现的同一认证服务器撤销端点提交 Token。 */
  async revokeCredentials(
    connection: StoredMcpConnection,
  ): Promise<McpRemoval["remoteRevocation"]> {
    if (connection.auth !== "oauth" || !connection.oauthRef)
      return "not_applicable";
    const raw = this.options.credentials.read(connection.oauthRef);
    if (!raw) return "not_applicable";
    try {
      const record = JSON.parse(raw) as {
        tokens?: { access_token?: string; refresh_token?: string };
        client?: { client_id: string; client_secret?: string };
        discovery?: {
          authorizationServerUrl: string;
          authorizationServerMetadata?: {
            revocation_endpoint?: string;
            token_endpoint?: string;
          };
        };
      };
      const endpoint =
        record.discovery?.authorizationServerMetadata?.revocation_endpoint;
      if (!endpoint) return "unsupported";
      const target = new URL(endpoint);
      const issuer = new URL(
        record.discovery?.authorizationServerUrl ?? connection.url,
      );
      if (target.origin !== issuer.origin) return "unsupported";
      const tokens = [
        ...[record.tokens?.refresh_token].filter((value): value is string =>
          Boolean(value),
        ),
        ...[record.tokens?.access_token].filter((value): value is string =>
          Boolean(value),
        ),
      ];
      const client =
        record.client ??
        (connection.clientId ? { client_id: connection.clientId } : null);
      if (!client) return "unsupported";
      for (const token of tokens) {
        const body = new URLSearchParams({
          token,
          client_id: client.client_id,
        });
        if (client.client_secret)
          body.set("client_secret", client.client_secret);
        const response = await mcpFetch(connection.url)(target, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        if (!response.ok) return "failed";
      }
      return "succeeded";
    } catch {
      return "failed";
    }
  }
  async revokeWorkspace(workspaceId: string): Promise<void> {
    await Promise.all(
      [
        ...new Set(
          [...this.clients.values()]
            .filter((record) => record.workspaceId === workspaceId)
            .map((record) => record.connection.id),
        ),
      ].map((id) => this.disconnect(id, workspaceId)),
    );
  }
  async close(): Promise<void> {
    await Promise.all(
      [
        ...new Set(
          [...this.clients.values()].map((record) => record.connection.id),
        ),
      ].map((id) => this.disconnect(id)),
    );
  }
}
