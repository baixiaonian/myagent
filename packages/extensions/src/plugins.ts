/** 插件清单与来源端口：只解析声明和兼容性，不加载 JS 模块、不执行安装脚本。 */
import {
  AppError,
  type McpServerConfig,
  type PluginManifest,
  type PluginSource,
} from "@myagent/contracts";
import { parseHookDocument } from "./hooks.js";
import type { SkillPackage } from "./skills.js";
export interface PreparedPlugin {
  source: PluginSource;
  commit: string | null;
  manifest: PluginManifest;
  package: SkillPackage;
}
export interface PluginFilesPort {
  prepare(source: PluginSource, signal: AbortSignal): Promise<PreparedPlugin>;
  restore(pkg: SkillPackage, signal: AbortSignal): Promise<void>;
  verify(pkg: SkillPackage): void;
  collect(keep: Set<string>): void;
}
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
/** 清单中的路径永远相对包根；不接受变量、绝对路径或父级穿越。 */
export function pluginPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("${") ||
    value.startsWith("/")
  )
    throw new AppError("invalid_plugin", "插件组件必须使用包内相对路径。");
  const p = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (!p || p.split("/").some((s) => s === ".." || s === "." || !s))
    throw new AppError("invalid_plugin", "插件组件路径越界。");
  return p;
}
/** 输入只包含已经完成文件校验的包文件；兼容问题可逐项排除，结构错误不能降级为空成功。 */
export function parsePluginManifest(
  files: Map<string, string>,
  names: string[],
): PluginManifest {
  const entry = files.has("plugin.json")
    ? "plugin.json"
    : ".codex-plugin/plugin.json";
  const read = (path: string): Record<string, unknown> => {
    const text = files.get(path);
    if (text === undefined)
      throw new AppError("invalid_plugin", `缺少插件声明文件：${path}`);
    try {
      const v: unknown = JSON.parse(text);
      if (object(v)) return v;
    } catch {}
    throw new AppError("invalid_plugin", `插件 JSON 无效：${path}`);
  };
  const raw = read(entry),
    portable = entry === "plugin.json";
  if (
    typeof raw.name !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(raw.name)
  )
    throw new AppError(
      "invalid_plugin",
      "插件名称需使用小写字母、数字、点、横线或下划线。",
    );
  if (
    raw.version !== undefined &&
    (typeof raw.version !== "string" || raw.version.length > 100)
  )
    throw new AppError("invalid_plugin", "插件版本格式无效。");
  const out: PluginManifest = {
    name: raw.name,
    description:
      typeof raw.description === "string" ? raw.description.slice(0, 4000) : "",
    declaredVersion: typeof raw.version === "string" ? raw.version : null,
    format: portable ? "agent" : "codex",
    components: [],
    issues: [],
  };
  const issue = (id: string, message: string) => {
    if (!out.components.some((c) => c.id === id))
      out.components.push({ id, kind: "unsupported", name: id });
    out.issues.push({ id, componentId: id, message, blocking: true });
  };
  const extensions = object(raw.extensions) ? raw.extensions : {};
  const native = object(extensions["com.myagent"])
    ? extensions["com.myagent"]
    : {};
  const codex = object(extensions["com.openai"])
    ? extensions["com.openai"]
    : raw;
  if (native.apiVersion !== undefined && native.apiVersion !== 1)
    throw new AppError("invalid_plugin", "MyAgent 插件 API 版本不支持。");
  if (
    portable &&
    raw.$schema !== undefined &&
    raw.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
  )
    throw new AppError("invalid_plugin", "插件清单 Schema 版本不支持。");
  for (const key of [
    "commands",
    "agents",
    "dependencies",
    "scripts",
    "apps",
    "hooks",
  ])
    if (raw[key] !== undefined && !(key === "hooks" && native.hooks))
      issue(`external:${key}`, `${key} 声明尚不支持，请适配或明确排除。`);
  for (const key of ["apps", "hooks"])
    if (codex[key] !== undefined && codex !== raw)
      issue(`external:${key}`, `OpenAI ${key} 声明需要适配。`);
  if (names.includes(".app.json"))
    issue("external:apps", "此包包含外部连接器配置，MyAgent 不能直接接入。");
  if (names.includes("hooks/hooks.json") && !native.hooks)
    issue(
      "external:hooks",
      "外部 Hook 协议不能直接执行，请声明 MyAgent Hook。",
    );
  for (const key of Object.keys(native))
    if (!["apiVersion", "hooks"].includes(key))
      issue(`native:${key}`, `不支持 MyAgent 扩展字段 ${key}。`);
  const roots = portable
    ? ["skills"]
    : typeof raw.skills === "string"
      ? [pluginPath(raw.skills)]
      : Array.isArray(raw.skills)
        ? raw.skills.map(pluginPath)
        : ["skills"];
  for (const root of roots) {
    const skillFiles = names.filter(
      (n) =>
        n === `${root}/SKILL.md` ||
        (n.startsWith(`${root}/`) &&
          n.endsWith("/SKILL.md") &&
          n.slice(root.length + 1).split("/").length === 2),
    );
    if (!skillFiles.length && !portable && raw.skills !== undefined)
      issue(`skill:${root}`, `声明的技能目录没有 SKILL.md：${root}`);
    for (const file of skillFiles) {
      const path = file.slice(0, -9),
        id = `skill:${path}`;
      if (!out.components.some((c) => c.id === id))
        out.components.push({
          id,
          kind: "skill",
          name: path.split("/").at(-1) ?? path,
          path,
        });
    }
  }
  let mcp: unknown;
  if (portable && files.has("mcp.json")) mcp = read("mcp.json");
  else if (!portable) {
    if (typeof raw.mcpServers === "string")
      mcp = read(pluginPath(raw.mcpServers));
    else if (object(raw.mcpServers)) mcp = raw.mcpServers;
    else if (files.has(".mcp.json")) mcp = read(".mcp.json");
  }
  if (mcp !== undefined) {
    const servers =
      object(mcp) && object(mcp.mcpServers) ? mcp.mcpServers : mcp;
    if (!object(servers))
      throw new AppError("invalid_plugin", "MCP 声明必须是对象。");
    for (const [name, value] of Object.entries(servers)) {
      const id = `mcp:${name}`;
      if (!object(value)) {
        issue(id, "MCP 条目无效。");
        continue;
      }
      const config = { ...value };
      delete config.$schema;
      if (config.type !== undefined) {
        if (
          !["stdio", "http", "streamable-http"].includes(String(config.type))
        ) {
          issue(id, "不支持此 MCP 传输协议。");
          continue;
        }
        config.transport = config.type === "stdio" ? "stdio" : "http";
        delete config.type;
      }
      const supported = [
        "transport",
        "command",
        "args",
        "url",
        "enabled",
        "toolExposure",
        "auth",
        "token",
        "env",
        "clientId",
        "clientMetadataUrl",
        "networkDomains",
        "additionalPaths",
      ];
      if (Object.keys(config).some((k) => !supported.includes(k))) {
        issue(id, "MCP 配置含不支持字段（例如 headers/cwd），请适配。");
        continue;
      }
      const text = JSON.stringify(config)
        .replaceAll("${PLUGIN_ROOT}", "")
        .replaceAll("${CLAUDE_PLUGIN_ROOT}", "");
      if (/\$\{/.test(text)) {
        issue(id, "MCP 配置包含不支持的动态变量，请改为在插件设置中录入。");
        continue;
      }
      // 包内容不承载秘密；所有环境值由用户在管理页输入，防止在预览或日志回显认证材料。
      if (
        config.token ||
        (object(config.env) && Object.keys(config.env).length)
      ) {
        issue(id, "包内 token/env 需移至插件凭证设置后再安装。");
        continue;
      }
      out.components.push({
        id,
        kind: "mcp",
        name,
        mcp: config as McpServerConfig,
      });
    }
  }
  if (native.hooks !== undefined) {
    const paths = Array.isArray(native.hooks) ? native.hooks : [native.hooks];
    for (const p of paths) {
      const path = pluginPath(p),
        doc = parseHookDocument(JSON.stringify(read(path)));
      for (const hook of doc.hooks) {
        const packagePath = pluginPath(hook.packagePath);
        const id = `hook:${hook.id}`;
        if (out.components.some((c) => c.id === id))
          throw new AppError("invalid_plugin", "插件 Hook ID 重复。");
        if (!names.includes(`${packagePath}/${hook.entry}`))
          throw new AppError("invalid_plugin", "插件 Hook 入口不在包内。");
        out.components.push({
          id,
          kind: "hook",
          name: hook.id,
          hook: { ...hook, packagePath },
        });
      }
    }
  }
  if (!out.components.length)
    throw new AppError("invalid_plugin", "插件没有可识别的组件。");
  if (out.components.length > 200)
    throw new AppError("invalid_plugin", "插件组件超过 200 项。");
  return out;
}
