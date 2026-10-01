/**
 * 后端唯一组合根：装配 SQLite、凭证、模型工厂和应用服务，提供 HTTP / SSE 与 Web 静态资源。
 * 本文件拥有进程锁及服务生命周期；路由负责边界校验，生成语义交给 ChatService。
 * 日志和错误响应必须脱敏；浏览器断连只结束订阅，不终止后台 Run。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import staticPlugin from "@fastify/static";
import {
  builtinTools,
  FileCredentialStore,
  FileResultStore,
  LocalCaptureFiles,
  LocalCommandConfigFiles,
  LocalDocumentFiles,
  LocalHookFiles,
  LocalMcpConfigFiles,
  LocalMemoryFiles,
  LocalPluginFiles,
  LocalProjectDirectories,
  LocalProjectRules,
  LocalSkillFiles,
  LocalToolExecutor,
  LocalWorkspace,
  McpRuntime,
  NativeExecutionGateway,
  OpenAIChatModel,
  OpenAIResponsesModel,
  OtelTraceExporter,
  ShellCommandAnalyzer,
  type SkillFileLimits,
  SqliteChatStore,
  ToolRegistry,
} from "@myagent/adapters";
import {
  ChatService,
  CommandPolicyService,
  ContextService,
  DocumentService,
  ExecutionCoordinator,
  HookService,
  McpManager,
  McpSettingsService,
  MemoryService,
  type ModelFactory,
  ObservabilityService,
  PluginService,
  ProjectService,
  SettingsService,
  SkillService,
  TeamService,
  ToolService,
} from "@myagent/application";
import {
  type AgentLimits,
  AppError,
  type CreateSessionInput,
  type DirectorySelection,
  type HistoryQuery,
  isActiveRun,
  type MemoryQuery,
  type MemoryUpdate,
  type RegenerateInput,
  type RunInput,
  type SettingsInput,
} from "@myagent/contracts";
import { raceSignal, type ToolExecutor } from "@myagent/kernel";
import Fastify, { LogController } from "fastify";
import lockfile from "proper-lockfile";
import { registerCommandPolicyRoutes } from "../routes/command-policy.js";
import { registerDocumentRoutes } from "../routes/documents.js";
import { registerExecutionRoutes } from "../routes/execution.js";
import { registerHookRoutes } from "../routes/hooks.js";
import { registerMcpRoutes } from "../routes/mcp.js";
import { registerMcpManagementRoutes } from "../routes/mcp-management.js";
import { registerMemoryRoutes } from "../routes/memory.js";
import { registerObservationRoutes } from "../routes/observability.js";
import { registerPluginRoutes } from "../routes/plugins.js";
import { registerProjectRoutes } from "../routes/projects.js";
import {
  regenerateSchema,
  renameSchema,
  runSchema,
  settingsSchema,
} from "../routes/schemas.js";
import { registerSkillRoutes } from "../routes/skills.js";
import { registerTeamRoutes } from "../routes/teams.js";

// 禁用 Fastify 默认逐请求日志，避免自动记录可能包含敏感参数的 URL。
class LocalLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
export interface ServerOptions {
  dataDir: string;
  teamMaxMembers?: number;
  teamModelConcurrency?: number;
  workspaceRoot?: string;
  skillRoot?: string;
  skillLimits?: SkillFileLimits;
  directoryPicker?: () => Promise<DirectorySelection>;
  serveWeb?: boolean;
  captureFileLimit?: number;
  captureTotalLimit?: number;
  otlpEndpoint?: string;
  otlpHeaders?: Record<string, string>;
  logger?: boolean;
  logSink?: { write(message: string): void };
  devOrigin?: string;
  modelFactory?: ModelFactory;
  timeoutMs?: number;
  agentLimits?: Partial<AgentLimits>;
  toolExecutor?: ToolExecutor;
  /** 仅测试装配可调触发阈值；用户容量仍来自设置快照。 */
  contextTriggerRatio?: number;
  /** 注入时钟用于后台空闲/UTC 配额测试，不修改用户真实系统时间。 */
  memoryNow?: () => number;
}
// 依次申请数据目录锁、数据库和凭证资源；初始化失败时释放已经拿到的资源。
// 所有具体适配器在此实例化，上层用例接收契约和工厂而不感知驱动。
export async function buildServer(options: ServerOptions) {
  for (const limit of [options.captureFileLimit, options.captureTotalLimit])
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new AppError("invalid_limits", "原始材料容量必须为正整数。");
  if (options.otlpEndpoint) {
    const url = new URL(options.otlpEndpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new AppError("invalid_settings", "OTLP 地址无效。");
  }
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  // 兼容旧版本的目录旁锁；升级前必须先停止旧实例。
  if (await lockfile.check(options.dataDir, { stale: 10000 })) {
    throw new AppError("data_in_use", "数据目录正由另一个实例使用。", 503);
  }
  // 锁放在可写数据卷内部，以支持父目录只读的普通用户容器；不依赖父目录可写。
  const release = await lockfile.lock(options.dataDir, {
    lockfilePath: join(options.dataDir, "server.lock"),
    stale: 10000,
    update: 2000,
    retries: 0,
  });
  let store: SqliteChatStore;
  try {
    store = new SqliteChatStore(join(options.dataDir, "state.db"));
  } catch (error) {
    await release();
    throw error;
  }
  const server = Fastify({
    logger: options.logger
      ? {
          level: "info",
          ...(options.logSink ? { stream: options.logSink } : {}),
          redact: ["req.headers.authorization", "req.headers.cookie"],
        }
      : false,
    logController: new LocalLogController(),
    bodyLimit: 65536,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  let credentials: FileCredentialStore;
  try {
    credentials = new FileCredentialStore(options.dataDir);
  } catch (error) {
    store.close();
    await release();
    throw error;
  }
  const observations = new ObservabilityService(
    store.observations,
    new LocalCaptureFiles(
      options.dataDir,
      options.captureFileLimit,
      options.captureTotalLimit,
    ),
    options.otlpEndpoint
      ? new OtelTraceExporter(options.otlpEndpoint, options.otlpHeaders)
      : undefined,
  );
  observations.runState = (id) => {
    try {
      const run = store.getRun(id);
      return { status: run.status, endedAt: run.endedAt, error: run.error };
    } catch {
      return null;
    }
  };
  await observations.initialize();
  // 模型工厂支持测试注入；生产按显式协议创建适配器，每次运行使用独立配置实例。
  const settings = new SettingsService(
    store,
    credentials,
    randomUUID,
    options.modelFactory ??
      ((config, key) =>
        config.apiProtocol === "responses"
          ? new OpenAIResponsesModel(
              config.baseUrl,
              key,
              config.model,
              observations,
            )
          : new OpenAIChatModel(
              config.baseUrl,
              key,
              config.model,
              observations,
            )),
  );
  settings.transportObserver = observations;
  const runtimeRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const memories = new MemoryService(
    store.memory,
    new LocalMemoryFiles(options.dataDir),
    store,
    store.execution,
    settings,
    options.memoryNow,
  );
  memories.historyReader = (sessionId, cursor) =>
    store.context.history(sessionId, {
      includeSuperseded: true,
      ...(cursor ? { cursor } : {}),
    });
  await memories.initialize();
  const skillRoot =
    options.skillRoot ??
    join(dirname(options.dataDir), `${basename(options.dataDir)}-skills`);
  // 嵌入式/测试装配未指定来源时不向数据卷的父目录写入；生产入口显式传入独立技能根。
  if (options.skillRoot) mkdirSync(skillRoot, { recursive: true, mode: 0o700 });
  const skillFiles = new LocalSkillFiles(
    resolve(options.dataDir),
    [realpathSync(runtimeRoot)],
    options.skillLimits,
  );
  const skills = new SkillService(
    store.skills,
    skillFiles,
    store,
    store.execution,
    resolve(skillRoot),
  );
  const workspaceAdapter = new LocalWorkspace(
    [realpathSync(options.dataDir), realpathSync(runtimeRoot)],
    [
      skillFiles.runtimeRoot,
      dirname(dirname(realpathSync(process.execPath))),
      "/opt/homebrew",
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/System",
    ],
  );
  const directories = new LocalProjectDirectories(
    workspaceAdapter,
    options.workspaceRoot ??
      join(dirname(options.dataDir), `${basename(options.dataDir)}-workspaces`),
    options.directoryPicker,
  );
  const projects = new ProjectService(
    store,
    store.execution,
    directories,
    randomUUID,
  );
  const registry = new ToolRegistry(workspaceAdapter, (context) => [
    ...skills.readPaths(context.runId),
    ...plugins.readPaths(context.runId),
  ]);
  const commands = new CommandPolicyService(
    store.execution,
    new LocalCommandConfigFiles(resolve(options.dataDir), store.execution),
    new ShellCommandAnalyzer(),
    workspaceAdapter,
  );
  const results = new FileResultStore(options.dataDir, store.execution);
  const mcp = new McpRuntime({
    observer: observations,
    store: store.execution,
    credentials,
    registry,
    dataDir: resolve(options.dataDir),
    runtimeRoot,
    callbackUrl: () => {
      const address = server.server.address();
      return `http://127.0.0.1:${address && typeof address !== "string" ? address.port : 3000}/api/v1/mcp/oauth/callback`;
    },
  });
  const mcpSettings = new McpSettingsService(
    store.execution,
    credentials,
    mcp,
    randomUUID,
  );
  const mcpManager = new McpManager(
    store.execution,
    credentials,
    new LocalMcpConfigFiles(resolve(options.dataDir), store.execution),
    mcp,
    mcpSettings,
    projects,
    randomUUID,
  );
  mcp.beforeCall = (id, workspaceId) => mcpManager.guard(id, workspaceId);
  try {
    await mcpManager.initialize();
    await commands.initialize();
  } catch (error) {
    await mcp.close();
    store.close();
    await release();
    throw error;
  }
  const teams = new TeamService(
    store.teams,
    store,
    store.execution,
    store.context,
    options.teamMaxMembers,
    options.teamModelConcurrency,
  );
  memories.sessionParent = (id) => teams.member(id)?.sessionId;
  teams.observer = observations;
  observations.resolveScope = (scope) => {
    const link = scope.runId ? teams.link(scope.runId) : null;
    if (!link) return scope;
    return {
      ...scope,
      rootRunId: link.rootRunId,
      agentId: link.agentId,
      agentName:
        link.agentId === "main"
          ? "主 Agent"
          : (teams.member(store.getRun(scope.runId!).sessionId)?.name ??
            "成员"),
      sessionId: link.sessionId,
    };
  };
  observations.isRecoverable = (runId) => {
    try {
      return isActiveRun(store.getRun(runId).status);
    } catch {
      return false;
    }
  };
  observations.readEvidence = (span) => {
    const step =
      span.scope.runId && span.scope.stepId
        ? store
            .getSteps(span.scope.runId)
            .find((row) => row.step.id === span.scope.stepId)?.step
        : undefined;
    const invocation = span.scope.invocationId
      ? store.execution.get("invocations", span.scope.invocationId)
      : null;
    const messageId = span.attributes["myagent.message.id"];
    const messages =
      typeof messageId === "string"
        ? store.teams
            .list("messages")
            .filter(
              (message) =>
                message.id === messageId &&
                message.rootRunId ===
                  (span.scope.rootRunId ?? span.scope.runId),
            )
        : [];
    return {
      ...(step ? { step } : {}),
      ...(invocation && invocation.runId === span.scope.runId
        ? { invocation }
        : {}),
      ...(messages.length ? { messages } : {}),
    };
  };
  settings.wrapModel = (model, config) =>
    teams.limitModel(observations.wrapModel(model, config));
  results.inlineResult = (id, sessionId) => teams.controlResult(id, sessionId);
  const processSpans = new Map<
    string,
    ReturnType<ObservabilityService["span"]>
  >();
  let toolSystem: ToolService;
  const gateway = new NativeExecutionGateway({
    dataDir: resolve(options.dataDir),
    runtimeRoot,
    protectedPaths: [resolve(options.dataDir), join(runtimeRoot, ".env")],
    readOnlyPaths: (id) => [...skills.readPaths(id), ...plugins.readPaths(id)],
    prepareResources: (id, signal) => skills.restoreResources(id, signal),
    onProcess: async (event) => {
      const run = store.getRun(event.process.runId);
      if (!isActiveRun(run.status)) return;
      const old = store.execution.get("processes", event.process.id);
      if (old?.outputRef) event.process.outputRef = old.outputRef;
      if (
        event.process.status !== "running" &&
        !event.process.outputRef &&
        existsSync(event.outputPath)
      ) {
        const reference = await results.importOutput(
          {
            runId: run.id,
            sessionId: run.sessionId,
            stepId: "",
            invocationId: event.process.invocationId,
            workspace: toolSystem.workspace(run.sessionId),
          },
          event.outputPath,
          event.process.status !== "unknown" &&
            event.process.outputComplete !== false,
        );
        event.process.outputRef = reference.id;
      }
      store.execution.put("processes", event.process);
      const p = event.process;
      if (!processSpans.has(p.id) && !old)
        processSpans.set(
          p.id,
          observations.span(
            {
              runId: p.runId,
              sessionId: p.sessionId,
              invocationId: p.invocationId,
              processId: p.id,
            },
            "process.lifecycle",
            { "myagent.worker_started_at": p.createdAt },
          ),
        );
      if (p.status !== "running") {
        processSpans.get(p.id)?.end(p.status, {
          ...(p.durationMs !== undefined
            ? { "myagent.worker_duration_ms": p.durationMs }
            : {}),
          ...(p.exitCode !== null ? { "process.exit.code": p.exitCode } : {}),
        });
        processSpans.delete(p.id);
      }
      if (event.process.status === "unknown")
        toolSystem.recordUncertainProcess(event.process);
      toolSystem.processChanged(event.process.runId);
    },
    customDispatch: async (request, signal) => {
      const memoryArgs = request.prepared.arguments;
      if (request.prepared.descriptor.name === "search_skills")
        return JSON.parse(
          JSON.stringify(
            skills.search(
              request.context.runId,
              String(memoryArgs.query ?? ""),
              memoryArgs.cursor === undefined
                ? undefined
                : String(memoryArgs.cursor),
            ),
          ),
        );
      if (request.prepared.descriptor.name === "load_skill")
        return skills.load(request.context, String(memoryArgs.id), signal);
      if (request.prepared.descriptor.name === "read_skill_resource")
        return JSON.parse(
          JSON.stringify(
            skills.resource(
              request.context.runId,
              String(memoryArgs.id),
              String(memoryArgs.path ?? ""),
              memoryArgs.cursor === undefined
                ? undefined
                : String(memoryArgs.cursor),
            ),
          ),
        );
      if (request.prepared.descriptor.name === "search_memories")
        return JSON.parse(
          JSON.stringify(
            await memories.search(
              memoryArgs as MemoryQuery,
              request.context.sessionId,
            ),
          ),
        );
      if (request.prepared.descriptor.name === "read_memory")
        return JSON.parse(
          JSON.stringify(
            await memories.readEntry(
              String(memoryArgs.id),
              memoryArgs.cursor === undefined
                ? undefined
                : String(memoryArgs.cursor),
              memoryArgs.sourceId === undefined
                ? undefined
                : String(memoryArgs.sourceId),
              request.context.sessionId,
            ),
          ),
        );
      if (request.prepared.descriptor.name === "update_memory") {
        const result = await memories.update(
          {
            ...memoryArgs,
            requestId: request.context.invocationId,
          } as unknown as MemoryUpdate,
          request.context,
          signal,
        );
        return JSON.parse(JSON.stringify({ saved: true, entry: result }));
      }
      if (request.prepared.descriptor.source.kind === "mcp")
        return mcp.call(request, signal);
      if (request.prepared.descriptor.name === "search_tools")
        return toolSystem.searchTools(
          request.context.runId,
          String(request.prepared.arguments.query),
          String(request.prepared.arguments.cursor ?? "0"),
          Number(request.prepared.arguments.limit ?? 5),
        );
      if (request.prepared.descriptor.name === "read_conversation_history")
        return JSON.parse(
          JSON.stringify(
            store.context.history(
              request.context.sessionId,
              request.prepared.arguments as HistoryQuery,
            ),
          ),
        );
      if (request.prepared.descriptor.name === "read_tool_result") {
        const page = await results.read(
          String(request.prepared.arguments.resultId),
          teams.link(request.context.runId)
            ? teams.resultOwner(
                request.context.runId,
                String(request.prepared.arguments.resultId),
              )
            : request.context.sessionId,
          request.prepared.arguments.cursor === undefined
            ? undefined
            : String(request.prepared.arguments.cursor),
          Number(request.prepared.arguments.limit ?? 8000),
        );
        return { ...page };
      }
      throw new AppError("mcp_unavailable", "MCP 连接尚未就绪。");
    },
  });
  const coordinator = new ExecutionCoordinator();
  teams.waitConflict = (runId) => coordinator.waitConflict(runId);
  const hookFiles = new LocalHookFiles(
    resolve(options.dataDir),
    store.execution,
    [join(runtimeRoot, ".env")],
    process.env.MYAGENT_HOOK_ROOT,
  );
  const plugins: PluginService = new PluginService(
    store.plugins,
    new LocalPluginFiles(resolve(options.dataDir), [join(runtimeRoot, ".env")]),
    store,
    store.execution,
    credentials,
    hookFiles,
    mcp,
    () => projects.diagnostic(),
  );
  await plugins.recover();
  skills.pluginSources = (workspaceId, runId) =>
    plugins.skillSources(workspaceId, runId);
  const hooks = new HookService(
    store.hooks,
    store,
    store.execution,
    hookFiles,
    gateway,
    results,
    coordinator,
    randomUUID,
  );
  hooks.pluginHooks = (runId, scope) => plugins.hooks(runId, scope);
  hooks.pluginPackageVersions = () =>
    store.plugins
      .list("bindings")
      .filter((b) => !b.removed && !b.inherit)
      .flatMap((b) => b.hooks.map((h) => h.package.version));
  mcp.beforeCall = async (id, workspaceId, runId) => {
    if (store.execution.get("connections", id)?.plugin)
      plugins.guard(id, workspaceId, runId);
    else await mcpManager.guard(id, workspaceId);
  };
  mcpManager.pluginOverview = (workspaceId) =>
    store.execution
      .list("connections")
      .filter((c) => c.plugin && plugins.allows(c.id, workspaceId))
      .map((c) => ({
        ...mcp.state(c.id, workspaceId),
        id: c.id,
        name: c.name,
        scope: c.pluginScope ?? "user",
        workspaceId,
        enabled: c.enabled !== false,
        overridden: false,
        config: {
          transport: c.transport,
          toolExposure: c.toolExposure ?? "deferred",
          command: c.command,
          args: c.args,
          url: c.url,
        },
        plugin: c.plugin!,
      }));
  toolSystem = new ToolService({
    control: teams,
    grantSession: (id) => teams.member(id)?.sessionId ?? id,
    allowed: (runId, name) => teams.allowed(runId, name),
    pluginAllowed: (id, workspaceId, runId) =>
      plugins.allows(id, workspaceId, runId),
    coordinator,
    hooks,
    store: store.execution,
    chat: store,
    registry,
    gateway,
    results,
    workspaces: workspaceAdapter,
    id: randomUUID,
    commands,
    trustedReadPaths: (id) => [
      ...skills.readPaths(id),
      ...plugins.readPaths(id),
    ],
    commitResult: (invocation, result) => skills.commit(invocation, result),
    revokeExternal: (workspaceId) => mcp.revokeWorkspace(workspaceId),
  });
  const contexts = new ContextService(
    store.context,
    store,
    store.execution,
    new LocalProjectRules(),
    (id) =>
      [toolSystem.effectsContext(id), teams.effectsContext(id)]
        .filter(Boolean)
        .join("\n"),
    memories,
    options.contextTriggerRatio,
    results,
    skills,
    hooks,
  );
  contexts.historyAugment = (runId, messages) => teams.augment(runId, messages);
  const chat = new ChatService(
    store,
    settings,
    options.timeoutMs,
    options.toolExecutor ?? new LocalToolExecutor(builtinTools()),
    options.agentLimits,
    options.toolExecutor ? undefined : toolSystem,
    contexts,
    memories,
    skills,
    options.toolExecutor ? undefined : hooks,
    plugins,
  );
  if (!options.toolExecutor) {
    toolSystem.observer = observations;
    memories.observer = observations;
    skills.observer = observations;
    contexts.observer = observations;
    hooks.observer = observations;
    chat.observations = observations;
    chat.team = teams;
    chat.prepareExecution = async (run, signal) => {
      if (run.executionMode !== "full_access") return;
      const workspaceId = store.snapshot(run.sessionId).session.workspaceId;
      if (!workspaceId) return;
      for (const connection of store.execution.list("connections")) {
        if (
          !connection.workspaceIds.includes(workspaceId) ||
          connection.enabled === false ||
          connection.blocked
        )
          continue;
        signal.throwIfAborted();
        try {
          await mcp.beforeCall?.(connection.id, workspaceId, run.id);
          await raceSignal(
            mcp.connect(connection.id, workspaceId, "full_access"),
            signal,
          );
        } catch {
          /* 连接失败保留真实状态，不回退到标准连接或重放业务调用。 */
        }
      }
      signal.throwIfAborted();
    };
    teams.connect({
      startMember: (sessionId, rootRunId, requestId, content) => {
        const parent = memories.sessionSettings(
          store.getRun(rootRunId).sessionId,
        );
        memories.saveSession(sessionId, {
          expectedRevision: memories.sessionSettings(sessionId).revision,
          useMemories: parent.useMemories,
          contributeMemories: false,
        });
        return chat.start(
          sessionId,
          {
            requestId,
            content,
            expectedRevision: store.snapshot(sessionId).session.revision,
          },
          "send",
          rootRunId,
        );
      },
      resume: (id) => chat.resume(id),
      stop: (id) => chat.cancel(id),
      executing: (id) => chat.executing(id),
    });
  }
  teams.recover();
  // 正式接受请求之前修补上次遗留 Run；不把它们重新加入当前 active Map 或发起模型重试。
  store.recoverInterrupted();
  try {
    await toolSystem.recover();
    await hooks.recover();
  } catch (error) {
    await plugins.close();
    await gateway.close();
    await mcp.close();
    store.close();
    await release();
    throw error;
  }
  skills.collect();
  hooks.collect();
  let maintaining = false;
  const maintenance = setInterval(() => {
    if (maintaining) return;
    maintaining = true;
    void chat
      .maintain()
      .then(() => teams.maintain())
      .then(() => mcpManager.refresh())
      .then(() => plugins.maintain())
      .then(() => memories.maintain())
      .then(() => observations.maintain())
      .catch(() => {
        /* 维护写入失败不伪造状态，正在执行的 Run 仍有独立持久化/取消保护。 */
      })
      .finally(() => {
        maintaining = false;
      });
  }, 1000);
  const streams = new Set<() => void>();
  // 先关闭长连接使 Fastify 能退出，再取消活动模型并落终态；数据库和锁留到 onClose 释放。
  server.addHook("preClose", async () => {
    clearInterval(maintenance);
    for (const end of streams) end();
    await memories.close();
    await chat.close();
  });
  server.addHook("onClose", async () => {
    await mcpManager.close();
    await plugins.close();
    await gateway.close();
    await mcp.close();
    skills.close();
    await observations.close();
    store.close();
    await release();
  });
  registerObservationRoutes(server, observations);
  registerMemoryRoutes(server, memories);
  registerTeamRoutes(server, teams);
  registerSkillRoutes(server, skills);
  registerHookRoutes(server, hooks);
  registerPluginRoutes(server, plugins);
  // 本地单用户仍需防御跨站访问与 DNS rebinding；校验 Host / Origin，而不仅依赖 loopback 监听。
  server.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    let host: URL;
    try {
      host = new URL(`http://${request.headers.host ?? ""}`);
    } catch {
      throw new AppError("invalid_host", "无效的本地访问地址。", 403);
    }
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(host.hostname) ||
      host.username ||
      host.password
    )
      throw new AppError("invalid_host", "该服务仅供本机访问。", 403);
    const origin = request.headers.origin;
    const sameOrigin = `${request.protocol}://${request.headers.host}`;
    const oauthCallback =
      request.method === "GET" &&
      request.url.split("?")[0] === "/api/v1/mcp/oauth/callback";
    if (
      !oauthCallback &&
      origin &&
      origin !== sameOrigin &&
      origin !== options.devOrigin
    )
      throw new AppError("invalid_origin", "不允许来自其他网站的请求。", 403);
    // 没有 Origin 的浏览器跨站请求也必须拒绝；非浏览器本机客户端可不发送这些头。
    if (
      !oauthCallback &&
      !origin &&
      request.headers["sec-fetch-site"] === "cross-site"
    )
      throw new AppError("invalid_origin", "不允许跨站请求。", 403);
    if (request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
      if (
        ["POST", "PUT", "PATCH"].includes(request.method) &&
        !request.headers["content-type"]?.startsWith("application/json")
      )
        throw new AppError("invalid_content_type", "请求必须使用 JSON。", 415);
    }
  });
  // 只公开 AppError 的安全消息；验证错误和未知异常统一提示，不把原始异常对象交给日志器。
  server.setErrorHandler((error, request, reply) => {
    const known = error instanceof AppError;
    const validation =
      typeof error === "object" && error !== null && "validation" in error;
    const clientError =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500;
    const status = known ? error.status : validation || clientError ? 400 : 500;
    const code = known
      ? error.code
      : validation || clientError
        ? "invalid_input"
        : "internal_error";
    // 不记录上游异常对象、请求正文或 URL，防止兼容服务在错误中回显密钥。
    request.log.error({ code, requestId: request.id }, "Request failed");
    reply.status(status).send({
      error: {
        code,
        message: known
          ? error.message
          : validation || clientError
            ? "输入格式不正确，请检查填写内容。"
            : "本地服务处理失败，请检查数据目录或稍后重试。",
      },
    });
  });
  registerCommandPolicyRoutes(server, commands, store.execution, registry);
  registerExecutionRoutes(server, toolSystem, chat);
  registerMcpRoutes(server, mcpSettings, mcp, mcpManager);
  registerProjectRoutes(server, projects, mcpManager);
  registerDocumentRoutes(
    server,
    new DocumentService(
      store.execution,
      new LocalDocumentFiles(workspaceAdapter),
      coordinator,
      () => toolSystem.concerns(),
    ),
  );
  registerMcpManagementRoutes(server, mcpManager);
  server.get("/healthz", async () => ({ status: "ok" }));
  server.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/context",
    async (request) => contexts.view(request.params.id),
  );
  server.get<{
    Params: { id: string };
    Querystring: Omit<HistoryQuery, "limit" | "includeSuperseded"> & {
      limit?: string;
      includeSuperseded?: string;
    };
  }>(
    "/api/v1/sessions/:id/history",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", maxLength: 500 },
            sourceId: { type: "string", maxLength: 500 },
            cursor: { type: "string", maxLength: 2000 },
            limit: { type: "string", pattern: "^(?:[1-9]|1[0-9]|20)$" },
            includeSuperseded: { enum: ["true", "false"] },
          },
        },
      },
    },
    async (request) =>
      store.context.history(request.params.id, {
        ...request.query,
        limit: Number(request.query.limit ?? 20),
        includeSuperseded: request.query.includeSuperseded === "true",
      }),
  );
  server.get("/api/v1/settings", async () => settings.get());
  server.put<{ Body: SettingsInput }>(
    "/api/v1/settings",
    { schema: { body: settingsSchema } },
    async (request) => settings.save(request.body),
  );
  server.post<{ Body: SettingsInput }>(
    "/api/v1/settings/test",
    { schema: { body: settingsSchema } },
    async (request) => {
      await settings.test(request.body);
      return { ok: true };
    },
  );
  // 简单会话 CRUD 当前直接访问注入的仓储；涉及执行生命周期的生成、取消与删除由应用层协调。
  server.get("/api/v1/sessions", async () => ({
    sessions: store.listSessions(),
  }));
  server.post<{ Body: CreateSessionInput }>(
    "/api/v1/sessions",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            requestId: { type: "string", minLength: 1, maxLength: 200 },
            path: { type: "string", minLength: 1, maxLength: 4096 },
          },
        },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await projects.create(request.body)),
  );
  async function prepareRun(
    sessionId: string,
    input: RunInput | RegenerateInput,
  ) {
    const before = store.snapshot(sessionId);
    const workspace = await projects.ensure(sessionId);
    await mcpManager.activate(workspace);
    if (
      !before.session.workspaceId &&
      input.expectedRevision === before.session.revision
    )
      return {
        ...input,
        expectedRevision: store.snapshot(sessionId).session.revision,
      };
    return input;
  }
  server.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id",
    async (request) => store.snapshot(request.params.id),
  );
  server.patch<{
    Params: { id: string };
    Body: { title: string; expectedRevision: number };
  }>(
    "/api/v1/sessions/:id",
    { schema: { body: renameSchema } },
    async (request) =>
      store.renameSession(
        request.params.id,
        request.body.title,
        request.body.expectedRevision,
      ),
  );
  server.delete<{ Params: { id: string } }>(
    "/api/v1/sessions/:id",
    async (request, reply) => {
      await chat.deleteSession(request.params.id);
      reply.status(204).send();
    },
  );
  server.post<{ Params: { id: string }; Body: RunInput }>(
    "/api/v1/sessions/:id/runs",
    { schema: { body: runSchema } },
    async (request, reply) =>
      // start 已提交 Run 后立即返回 202；不把模型网络请求绑定到这条 HTTP 响应的存活时间。
      reply
        .status(202)
        .send(
          chat.start(
            request.params.id,
            (await prepareRun(request.params.id, request.body)) as RunInput,
          ),
        ),
  );
  server.post<{ Params: { id: string }; Body: RegenerateInput }>(
    "/api/v1/sessions/:id/regenerate",
    { schema: { body: regenerateSchema } },
    async (request, reply) =>
      reply
        .status(202)
        .send(
          chat.start(
            request.params.id,
            await prepareRun(request.params.id, request.body),
            "regenerate",
          ),
        ),
  );
  server.post<{ Params: { id: string } }>(
    "/api/v1/runs/:id/cancel",
    async (request) => chat.cancel(request.params.id),
  );
  server.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/v1/sessions/:id/events",
    async (request, reply) => {
      const sessionId = request.params.id;
      const snapshot = store.snapshot(sessionId);
      // 自动重连时浏览器的 Last-Event-ID 优先于初始 after，防止每次都从旧快照游标重复补读。
      const after = Number(
        request.headers["last-event-id"] ?? request.query.after ?? 0,
      );
      if (!Number.isSafeInteger(after) || after < 0 || after > snapshot.cursor)
        throw new AppError("invalid_cursor", "事件游标无效，请重新加载会话。");
      // SSE 接管原始响应，由本路由管理结束和背压；游标检查必须在发送响应头之前完成。
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": connected\n\n");
      let cursor = after;
      let blocked = false;
      let closed = false;
      const drain = () => {
        blocked = false;
      };
      // 从已提交事件日志读取，和模型回调解耦；缓冲区满时暂停下一轮读取，等待 drain。
      const poll = () => {
        if (closed || blocked) return;
        try {
          for (const event of store.events(sessionId, cursor)) {
            const writable = reply.raw.write(
              `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            // write 返回 false 仍表示该事件已入 socket 缓冲，因此先推进游标再暂停，不能重复写同一帧。
            cursor = event.seq;
            if (!writable) {
              blocked = true;
              break;
            }
          }
        } catch (error) {
          if (error instanceof AppError && error.code === "not_found")
            reply.raw.write("event: deleted\ndata: {}\n\n");
          else reply.raw.write("event: unavailable\ndata: {}\n\n");
          end();
        }
      };
      const timer = setInterval(poll, 250);
      // 空注释帧只保活，不消费业务事件序号；浏览器不会把它当 ChatEvent。
      const heartbeat = setInterval(() => {
        if (!closed && !blocked) blocked = !reply.raw.write(": heartbeat\n\n");
      }, 15000);
      // 订阅清理只释放定时器和 socket 监听，不调用 chat.cancel；生成由用户命令或服务退出终止。
      const end = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearInterval(heartbeat);
        streams.delete(end);
        reply.raw.off("drain", drain);
        reply.raw.end();
      };
      reply.raw.on("drain", drain);
      reply.raw.on("close", end);
      streams.add(end);
      poll();
    },
  );
  // 生产托管编译后的 Web；未命中页面路由可回退 index.html，API 或缺失资产不能伪装成页面成功。
  const webRoot = fileURLToPath(new URL("../../../web/dist", import.meta.url));
  if (options.serveWeb !== false && existsSync(webRoot)) {
    await server.register(staticPlugin, { root: webRoot, wildcard: false });
    server.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        request.headers.accept?.includes("text/html")
      )
        return reply.sendFile("index.html");
      return reply
        .status(404)
        .send({ error: { code: "not_found", message: "页面或接口不存在。" } });
    });
  }
  await server.ready();
  return {
    observations,
    teams,
    server,
    chat,
    contexts,
    settings,
    memories,
    skills,
    hooks,
    plugins,
    store,
    toolSystem,
    gateway,
    registry,
    mcp,
    mcpSettings,
    projects,
    mcpManager,
  };
}
