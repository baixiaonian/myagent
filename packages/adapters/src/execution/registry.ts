/**
 * 统一工具注册表：同一 Schema 用于模型声明和执行前 Ajv 校验，参数不进行隐式类型转换。
 * 资源与锁由可信注册实现计算；模型不能靠修改说明、effects 或工具名称获得执行能力。
 */

import { isIP } from "node:net";
import { dirname } from "node:path";
import {
  AppError,
  type JsonValue,
  type ToolDescriptor,
} from "@myagent/contracts";
import type {
  ExecutionContext,
  PreparedTool,
  ToolRegistryPort,
} from "@myagent/kernel";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { builtinTools } from "../tools/index.js";
import { ShellCommandAnalyzer } from "./command-analysis.js";
import { canonicalPath, digest, type LocalWorkspace } from "./paths.js";
import { teamToolDescriptors } from "./team-tools.js";
import { toolValidationMessage } from "./validation-errors.js";

type Schema = Record<string, JsonValue>;
const string: Schema = { type: "string", minLength: 1 };
const positive: Schema = { type: "integer", minimum: 1, maximum: 10000 };
const schema = (properties: Schema, required: string[] = []): Schema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const pathFields = { path: string };
const accessPaths: Schema = {
  type: "array",
  maxItems: 10,
  items: schema({ path: string, access: { enum: ["read", "write"] } }, [
    "path",
    "access",
  ]),
};

export function executionToolDescriptors(): ToolDescriptor[] {
  const specs: {
    name: string;
    description: string;
    parameters: Schema;
    effects: ToolDescriptor["effects"];
    concurrency: ToolDescriptor["concurrency"];
    requiresWorkspace: boolean;
  }[] = [
    ...builtinTools().map((tool) => ({
      ...tool.definition,
      effects: "read" as const,
      concurrency: "shared" as const,
      requiresWorkspace: false,
    })),
    {
      name: "list_directory",
      description:
        "分页列出工作区目录。路径默认工作区根目录；cursor 为上次返回的分页游标。",
      parameters: schema({
        ...pathFields,
        cursor: { type: "string" },
        limit: positive,
      }),
      effects: "read",
      concurrency: "shared",
      requiresWorkspace: true,
    },
    {
      name: "search_files",
      description:
        "在工作区中按文件名或文本搜索，返回路径与行号。mode 默认 content；query 按普通文本匹配，不执行正则或 Shell。",
      parameters: schema(
        {
          ...pathFields,
          query: string,
          mode: { enum: ["path", "content"] },
          cursor: { type: "string" },
          limit: positive,
        },
        ["query"],
      ),
      effects: "read",
      concurrency: "shared",
      requiresWorkspace: true,
    },
    {
      name: "read_file",
      description:
        "读取 UTF-8 文件的一页文字，并返回内容哈希。分页 cursor 与文件哈希绑定；修改文件前先读取。",
      parameters: schema(
        { ...pathFields, cursor: { type: "string" }, limit: positive },
        ["path"],
      ),
      effects: "read",
      concurrency: "shared",
      requiresWorkspace: true,
    },
    {
      name: "write_file",
      description:
        "创建或完整覆盖 UTF-8 文件。新文件 expectedHash 必须为 null；覆盖须提供 read_file 返回的哈希，文件变化会拒绝写入。",
      parameters: schema(
        {
          ...pathFields,
          content: { type: "string", maxLength: 200000 },
          expectedHash: { type: ["string", "null"] },
        },
        ["path", "content", "expectedHash"],
      ),
      effects: "write",
      concurrency: "shared",
      requiresWorkspace: true,
    },
    {
      name: "edit_file",
      description:
        "精确替换文件中唯一出现的 oldText，必须提供读取时的 expectedHash；不做模糊匹配，冲突时重新读取。",
      parameters: schema(
        {
          ...pathFields,
          oldText: string,
          newText: { type: "string", maxLength: 200000 },
          expectedHash: string,
        },
        ["path", "oldText", "newText", "expectedHash"],
      ),
      effects: "write",
      concurrency: "shared",
      requiresWorkspace: true,
    },
    {
      name: "exec_command",
      description:
        "在工作区运行非登录 Shell 命令。查询/扫描请设置 readOnly:true：以强制只读沙箱和共享读锁执行，范围为 cwd 及 additionalPaths 中的只读目录，不能修改项目；精确读取优先 read_file/search_files，避免锁住整个项目。未声明只读的标准模式命令仅在程序与静态参数均已核验时自动只读，其他命令使用排他锁。完全访问下显式 readOnly 仍采用只读沙箱。短时间未退出返回 processId；用 read_process（waitMs<=10000）读取或 stop_process 停止。resource_busy/process_resource_busy 表示尚未派发，请根据持锁 Run/进程处理，不要重复提交冲突动作。等待成员只能使用 wait_agents（timeoutMs<=120000），不要用 sleep 轮询文件；等事件不占项目锁。递归扫描限定范围并 prune 排除目录。无 PTY，失败不自动重跑。",
      parameters: schema(
        {
          command: { ...string, maxLength: 32000 },
          cwd: string,
          yieldTimeMs: { type: "integer", minimum: 0, maximum: 10000 },
          timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
          readOnly: {
            type: "boolean",
            description:
              "在只读沙箱中执行，可与读取并行；禁止项目写入，不是自行声明无副作用。",
          },
          additionalPaths: accessPaths,
          networkDomains: { type: "array", maxItems: 20, items: string },
        },
        ["command"],
      ),
      effects: "unknown",
      concurrency: "exclusive",
      requiresWorkspace: true,
    },
    {
      name: "read_process",
      description:
        "读取本 Run 命令会话的新增输出及真实退出状态，waitMs 最多 10000。返回的 cursor 可用于下一次读取。",
      parameters: schema(
        {
          processId: string,
          cursor: { type: "string" },
          waitMs: { type: "integer", minimum: 0, maximum: 10000 },
        },
        ["processId"],
      ),
      effects: "read",
      concurrency: "control",
      requiresWorkspace: true,
    },
    {
      name: "write_stdin",
      description:
        "向当前 Run 的命令标准输入写文字；close 为 true 时关闭标准输入。不会改变启动时的沙箱权限。",
      parameters: schema(
        {
          processId: string,
          input: { type: "string", maxLength: 8000 },
          close: { type: "boolean" },
        },
        ["processId", "input"],
      ),
      effects: "unknown",
      concurrency: "control",
      requiresWorkspace: true,
    },
    {
      name: "stop_process",
      description: "终止当前 Run 的命令和受控子进程，并返回确认后的进程状态。",
      parameters: schema({ processId: string }, ["processId"]),
      effects: "read",
      concurrency: "control",
      requiresWorkspace: true,
    },
    {
      name: "read_conversation_history",
      description:
        "查询当前会话已保存的历史原文。支持 query 普通文本、sourceId 来源记录、cursor 续读；includeSuperseded 可查失败或被替换的旧记录。大结果使用 read_tool_result。",
      parameters: schema({
        query: { type: "string", maxLength: 500 },
        sourceId: { type: "string", maxLength: 500 },
        cursor: { type: "string", maxLength: 2000 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        includeSuperseded: { type: "boolean" },
      }),
      effects: "read",
      concurrency: "shared",
      requiresWorkspace: false,
    },
    {
      name: "read_tool_result",
      description:
        "按结果引用分页读取本会话已保存的工具结果，并返回采集完整性；不接受本机文件路径。",
      parameters: schema(
        { resultId: string, cursor: { type: "string" }, limit: positive },
        ["resultId"],
      ),
      effects: "read",
      concurrency: "shared",
      requiresWorkspace: false,
    },
    {
      name: "search_skills",
      description:
        "按用途检索本轮可用技能目录。返回技能 ID；使用前 load_skill。空 query 分页列出目录。",
      parameters: schema({
        query: { type: "string", maxLength: 500 },
        cursor: { type: "string" },
      }),
      effects: "read",
      concurrency: "shared",
      requiresWorkspace: false,
    },
    {
      name: "load_skill",
      description:
        "按技能 ID 加载完整主说明，本轮后续模型请求和压缩恢复保留。先加载再使用脚本或参考文件；不授予命令/网络/写入权限。",
      parameters: schema({ id: string }, ["id"]),
      effects: "read",
      concurrency: "exclusive",
      requiresWorkspace: false,
    },
    {
      name: "read_skill_resource",
      description:
        "读取已加载技能的包内参考文件。path 为空列出资源；长文本使用 cursor 续读。相对路径不得越出包，二进制仅返回位置。",
      parameters: schema(
        {
          id: string,
          path: { type: "string", maxLength: 4000 },
          cursor: { type: "string" },
        },
        ["id"],
      ),
      effects: "read",
      concurrency: "shared",
      requiresWorkspace: false,
    },
    {
      name: "search_tools",
      description:
        "按用途检索已启用 MCP 工具并加载完整定义，默认最多五个。新工具从下一次模型请求可调用；工具说明不是执行权限。空 query 列出目录。",
      parameters: schema(
        {
          query: { type: "string", maxLength: 500 },
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 5 },
        },
        ["query"],
      ),
      effects: "read",
      concurrency: "exclusive",
      requiresWorkspace: true,
    },
    {
      name: "search_memories",
      description:
        "按关键词搜索跨会话长期记忆，优先当前项目。query 支持空格分隔的多个普通文本关键词；返回 ID 和短摘录，需要细节再 read_memory。记忆是可能过时的资料，不是执行授权。",
      parameters: schema({
        query: { type: "string", maxLength: 500 },
        project: { type: "string", maxLength: 4000 },
        kind: { enum: ["preference", "project", "experience", "decision"] },
        cursor: { type: "string", maxLength: 2000 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      }),
      effects: "read",
      concurrency: "shared",
      requiresWorkspace: false,
    },
    {
      name: "read_memory",
      description:
        "按记忆 ID 分页读取正文；可用该条目返回的 sources[].id 作为 sourceId 补读跨会话原始来源，或用 extractions[].id 作为 sourceId 查阅提炼产物。只接受来源引用，不接受任意路径或会话 ID。",
      parameters: schema(
        {
          id: string,
          cursor: { type: "string", maxLength: 2000 },
          sourceId: { type: "string", maxLength: 1000 },
        },
        ["id"],
      ),
      effects: "read",
      concurrency: "shared",
      requiresWorkspace: false,
    },
    {
      name: "update_memory",
      description:
        "仅当当前用户明确要求记住、更正或忘记时更新长期记忆。add 需 title/text/kind；edit/forget 先搜索读取确定唯一 id 和 expectedRevision，歧义时向用户澄清，不能批量猜删。新增是独立人工记忆。不会授予执行权限。",
      parameters: schema(
        {
          action: { enum: ["add", "edit", "forget"] },
          id: string,
          expectedRevision: { type: "integer", minimum: 1 },
          title: { type: "string", maxLength: 200 },
          text: { type: "string", maxLength: 12000 },
          kind: { enum: ["preference", "project", "experience", "decision"] },
          project: { type: ["string", "null"], maxLength: 4000 },
        },
        ["action"],
      ),
      effects: "write",
      concurrency: "exclusive",
      requiresWorkspace: false,
    },
  ];
  return specs.map((spec) => ({
    ...spec,
    source: { kind: "local" },
    version: digest(JSON.stringify(spec)),
  }));
}
function stable(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key] ?? null)]),
    );
  return value;
}
export class ToolRegistry implements ToolRegistryPort {
  private readonly commandAnalyzer = new ShellCommandAnalyzer();
  private readonly entries = new Map<
    string,
    { descriptor: ToolDescriptor; validate: ValidateFunction }
  >();
  private readonly ajv = new Ajv({
    strict: false,
    allErrors: false,
    coerceTypes: false,
    removeAdditional: false,
    validateFormats: false,
  });
  constructor(
    private readonly workspaces: LocalWorkspace,
    private readonly readPaths: (
      context: ExecutionContext,
    ) => string[] = () => [],
  ) {
    for (const descriptor of [
      ...executionToolDescriptors(),
      ...teamToolDescriptors(),
    ])
      this.register(descriptor);
  }
  register(descriptor: ToolDescriptor): void {
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(descriptor.name) ||
      JSON.stringify(descriptor).length > 100000
    )
      throw new AppError("invalid_tool_definition", "工具名称或定义大小无效。");
    const old = this.entries.get(descriptor.name);
    if (
      old &&
      JSON.stringify(old.descriptor.source) !==
        JSON.stringify(descriptor.source)
    )
      throw new AppError("duplicate_tool", "工具名称发生冲突。");
    if (old?.descriptor.version === descriptor.version) return;
    try {
      const options = {
        strict: false,
        allErrors: false,
        coerceTypes: false,
        removeAdditional: false,
        validateFormats: false,
      };
      const validator =
        descriptor.source.kind === "mcp"
          ? String(descriptor.parameters.$schema ?? "").includes("draft-07")
            ? new Ajv(options)
            : new Ajv2020(options)
          : this.ajv;
      // 每次编译独立副本，拒绝依赖网络加载外部 $ref 的 Schema。
      this.entries.set(descriptor.name, {
        descriptor: structuredClone(descriptor),
        validate: validator.compile(structuredClone(descriptor.parameters)),
      });
    } catch {
      throw new AppError(
        "invalid_tool_schema",
        "工具 Schema 无法校验，该工具未启用。",
      );
    }
  }
  replaceConnection(
    connectionId: string,
    descriptors: ToolDescriptor[],
    workspaceId?: string,
    executionMode: import("@myagent/contracts").ExecutionMode = "standard",
  ): void {
    const previous = new Map(this.entries);
    try {
      this.removeConnection(connectionId, workspaceId, executionMode);
      for (const descriptor of descriptors) this.register(descriptor);
    } catch (error) {
      this.entries.clear();
      for (const [key, value] of previous) this.entries.set(key, value);
      throw error;
    }
  }
  removeConnection(
    connectionId: string,
    workspaceId?: string,
    executionMode?: import("@myagent/contracts").ExecutionMode,
  ): void {
    for (const [name, entry] of this.entries)
      if (
        entry.descriptor.source.kind === "mcp" &&
        entry.descriptor.source.connectionId === connectionId &&
        (!workspaceId || entry.descriptor.source.workspaceId === workspaceId) &&
        (!executionMode ||
          (entry.descriptor.source.executionMode ?? "standard") ===
            executionMode)
      )
        this.entries.delete(name);
  }
  descriptors(): ToolDescriptor[] {
    return [...this.entries.values()].map((entry) =>
      structuredClone(entry.descriptor),
    );
  }
  async prepare(
    name: string,
    rawArguments: string,
    context: ExecutionContext,
  ): Promise<PreparedTool> {
    const entry = this.entries.get(name);
    if (!entry) throw new AppError("unknown_tool", "工具未注册或已不可用。");
    let input: unknown;
    try {
      input = JSON.parse(rawArguments);
    } catch {
      throw new AppError("invalid_tool_arguments", "工具参数必须是完整 JSON。");
    }
    if (!entry.validate(input))
      throw new AppError(
        "invalid_tool_arguments",
        toolValidationMessage(name, entry.validate.errors),
      );
    const args = structuredClone(input) as Record<string, JsonValue>;
    const descriptor = structuredClone(entry.descriptor);
    let readOnlyExecution = false;
    const resources: PreparedTool["resources"] = [];
    const lockKeys: PreparedTool["lockKeys"] = [];
    if (descriptor.requiresWorkspace) {
      if (!context.workspace)
        throw new AppError(
          "workspace_required",
          "请先为当前会话绑定工作区。",
          409,
        );
      await this.workspaces.validate(context.workspace);
    }
    if (descriptor.source.kind === "mcp") {
      if (
        (descriptor.source.executionMode ?? "standard") !==
        (context.executionMode ?? "standard")
      )
        throw new AppError(
          "mcp_mode_mismatch",
          "MCP 工具不属于当前执行权限模式。",
          403,
        );
      if (
        descriptor.source.workspaceId &&
        descriptor.source.workspaceId !== context.workspace?.id
      )
        throw new AppError("mcp_unavailable", "工具不属于当前项目。", 403);
      resources.push({
        kind: "mcp",
        target: `${descriptor.source.connectionId}/${descriptor.source.originalName}`,
        access: "call",
      });
      lockKeys.push({
        key: `mcp:${descriptor.source.connectionId}`,
        mode: descriptor.effects === "read" ? "read" : "write",
      });
    } else if (
      [
        "list_directory",
        "search_files",
        "read_file",
        "write_file",
        "edit_file",
      ].includes(name)
    ) {
      const target = await canonicalPath(
        String(args.path ?? "."),
        context.workspace?.path ?? "/",
      );
      const write = descriptor.effects === "write";
      if (context.executionMode !== "full_access")
        this.workspaces.assertAccessible(target, write);
      args.path = target;
      const scope = write ? dirname(target) : target;
      if (context.executionMode !== "full_access")
        this.workspaces.assertAccessible(scope, write);
      resources.push({
        kind: "path",
        target: scope,
        access: write ? "write" : "read",
      });
      lockKeys.push({ key: `path:${target}`, mode: write ? "write" : "read" });
    } else if (name === "exec_command") {
      const cwd = await canonicalPath(
        String(args.cwd ?? "."),
        context.workspace?.path ?? "/",
      );
      if (context.executionMode !== "full_access")
        this.workspaces.assertAccessible(cwd, true);
      args.cwd = cwd;
      // 完全访问不被隐式降权；用户/模型显式请求只读时仍必须由 OS 强制执行。
      // 自动分类不依赖 allow 规则，任意解释器/重定向/未知选项继续保守互斥。
      readOnlyExecution = args.readOnly === true;
      if (
        args.readOnly === undefined &&
        context.executionMode !== "full_access" &&
        !(Array.isArray(args.networkDomains) && args.networkDomains.length) &&
        !(
          Array.isArray(args.additionalPaths) &&
          args.additionalPaths.some(
            (p) => (p as { access: string }).access === "write",
          )
        )
      ) {
        try {
          const analysis = await this.commandAnalyzer.analyze(
            String(args.command),
            cwd,
          );
          readOnlyExecution =
            !analysis.opaque &&
            analysis.commands.length > 0 &&
            analysis.commands.every((command) => command.safe);
        } catch {
          /* 分类不可用不获得共享锁；命令权限仍由正式派发前的策略负责。 */
        }
      }
      if (readOnlyExecution) {
        if (
          Array.isArray(args.additionalPaths) &&
          args.additionalPaths.some(
            (p) => (p as { access: string }).access === "write",
          )
        )
          throw new AppError(
            "invalid_tool_arguments",
            "readOnly=true 不接受 additionalPaths 的 write 权限；写入任务请使用普通命令。",
          );
        if (Array.isArray(args.networkDomains) && args.networkDomains.length)
          throw new AppError(
            "invalid_tool_arguments",
            "readOnly=true 不接受网络权限；联网操作请使用普通命令。",
          );
        descriptor.effects = "read";
        descriptor.concurrency = "shared";
        this.workspaces.assertAccessible(cwd, false);
      }
      for (const target of this.readPaths(context))
        resources.push({ kind: "path", target, access: "read" });
      resources.push({
        kind: "path",
        target: cwd,
        access: readOnlyExecution ? "read" : "write",
      });
      // 只读命令的 OS 可读范围限定在 cwd 与明确的额外目录，锁必须与该范围一致。
      // 普通未知 Shell 仍能写整个项目，因此不能只按 cwd 假装缩小写锁。
      if (context.workspace && !readOnlyExecution)
        lockKeys.push({
          key: `path:${context.workspace.path}`,
          mode: readOnlyExecution ? "read" : "write",
        });
      lockKeys.push({
        key: `path:${cwd}`,
        mode: readOnlyExecution ? "read" : "write",
      });
      for (const item of Array.isArray(args.additionalPaths)
        ? args.additionalPaths
        : []) {
        const scope = item as { path: string; access: "read" | "write" };
        scope.path = await canonicalPath(scope.path, cwd);
        if (context.executionMode !== "full_access" || readOnlyExecution)
          this.workspaces.assertAccessible(
            scope.path,
            scope.access === "write",
          );
        resources.push({
          kind: "path",
          target: scope.path,
          access: scope.access,
        });
        lockKeys.push({ key: `path:${scope.path}`, mode: scope.access });
      }
      args.networkDomains = (
        Array.isArray(args.networkDomains) ? args.networkDomains : []
      ).map((value) => {
        const domain = String(value).toLowerCase();
        // 防止受控命令通过本机 HTTP API 修改自己的授权；本轮网络授权仅允许具体公网域名。
        if (
          context.executionMode !== "full_access" &&
          (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) ||
            isIP(domain) ||
            !domain.includes(".") ||
            domain.endsWith(".localhost"))
        )
          throw new AppError(
            "invalid_network_scope",
            "命令网络授权需使用具体公网域名，不支持本机地址或通配符。",
          );
        resources.push({ kind: "network", target: domain, access: "connect" });
        return domain;
      });
    } else if (descriptor.concurrency === "control") {
      lockKeys.push({
        key: `process:${String(args.processId)}`,
        mode: descriptor.effects === "read" ? "read" : "write",
      });
    }
    return {
      readOnlyExecution,
      descriptor: structuredClone(descriptor),
      arguments: args,
      resources,
      lockKeys,
      fingerprint: digest(
        JSON.stringify(
          stable({
            executionMode: context.executionMode ?? "standard",
            version: descriptor.version,
            name,
            workspace: context.workspace?.identity ?? null,
            arguments: args,
            resources,
            readOnlyExecution,
          }),
        ),
      ),
    };
  }
  async revalidate(
    prepared: PreparedTool,
    context: ExecutionContext,
  ): Promise<void> {
    const current = await this.prepare(
      prepared.descriptor.name,
      JSON.stringify(prepared.arguments),
      context,
    );
    if (current.fingerprint !== prepared.fingerprint)
      throw new AppError(
        "execution_changed",
        "工具定义或路径在批准后发生变化，请重新请求。",
        409,
      );
  }
}
