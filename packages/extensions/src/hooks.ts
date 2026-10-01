/** Hook 纯配置、输出校验和文件端口；没有模型调用、文件系统或额外 Agent 循环。 */
import {
  AppError,
  type HookDefinition,
  type HookDocument,
  type HookEvent,
  type HookOutput,
  type McpConfigTarget,
  type ResourceAccess,
  type Workspace,
} from "@myagent/contracts";
import type { SkillPackage } from "./skills.js";
export interface FrozenHook {
  id: string;
  scope: "user" | "project";
  definition: HookDefinition;
  version: string;
  package: SkillPackage;
  interpreterPath: string;
  interpreterIdentity: string;
}
export interface HookInspection {
  path: string;
  text: string;
  revision: string;
  version: string;
  document: HookDocument;
  hooks: FrozenHook[];
}
export interface HookFilesPort {
  collect(keep: Set<string>): void;
  read(target: McpConfigTarget): {
    path: string;
    text: string;
    revision: string;
  };
  inspect(target: McpConfigTarget, text?: string): HookInspection;
  write(
    target: McpConfigTarget,
    text: string,
    expectedRevision: string,
  ): Promise<string>;
  capture(hooks: FrozenHook[], signal: AbortSignal): Promise<void>;
  restore(
    hook: FrozenHook,
    workspace: Workspace,
    signal: AbortSignal,
  ): Promise<ResourceAccess[]>;
  verify(hook: FrozenHook, workspace: Workspace): Promise<void>;
}
const invalid = (message: string): never => {
  throw new AppError("invalid_hook", message, 422);
};
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const fields = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    invalid("Hook 包含未知字段。");
};
const strings = (value: unknown, max = 100): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every(
    (v) => typeof v === "string" && v.length <= 4000 && !v.includes("\0"),
  );
export function parseHookDocument(text: string): HookDocument {
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : { schemaVersion: 1, hooks: [] };
  } catch (error) {
    return invalid(
      `Hook JSON 无效：${error instanceof Error ? error.message : "无法解析"}`,
    );
  }
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.hooks) ||
    value.hooks.length > 50
  )
    return invalid("Hook 需为 schemaVersion:1 和最多 50 项的 hooks 数组。");
  fields(value, ["schemaVersion", "hooks"]);
  const ids = new Set<string>();
  const hooks = value.hooks.map((item): HookDefinition => {
    if (!object(item)) return invalid("Hook 条目必须是对象。");
    fields(item, [
      "id",
      "event",
      "enabled",
      "packagePath",
      "entry",
      "interpreter",
      "args",
      "tools",
      "timeoutMs",
      "permissions",
    ]);
    if (
      typeof item.id !== "string" ||
      !/^[\w.-]{1,80}$/.test(item.id) ||
      ids.has(item.id)
    )
      return invalid("Hook id 必须唯一，使用字母、数字、点、横线或下划线。");
    ids.add(item.id);
    if (
      !["RunStart", "PreToolUse", "PostToolUse", "RunEnd"].includes(
        String(item.event),
      )
    )
      return invalid("Hook 事件无效。");
    if (item.enabled !== undefined && typeof item.enabled !== "boolean")
      return invalid("enabled 必须为布尔值。");
    if (
      typeof item.packagePath !== "string" ||
      !item.packagePath ||
      item.packagePath.length > 4000 ||
      item.packagePath.includes("\0")
    )
      return invalid("必须指定脚本包目录。");
    if (
      typeof item.entry !== "string" ||
      !item.entry ||
      item.entry.startsWith("/") ||
      item.entry.split(/[\\/]/).some((p) => p === ".." || !p) ||
      item.entry.includes("\0")
    )
      return invalid("入口必须是包内相对文件。");
    if (!["node", "python3", "sh"].includes(String(item.interpreter)))
      return invalid(
        "解释器仅支持可信 node、python3 或 sh；不能指定任意命令。",
      );
    if (item.args !== undefined && !strings(item.args))
      return invalid("args 必须是固定字符串数组。");
    if (
      item.tools !== undefined &&
      (!strings(item.tools) ||
        !["PreToolUse", "PostToolUse"].includes(String(item.event)))
    )
      return invalid("工具名精确匹配仅适用于工具前后事件。");
    const timeout = item.timeoutMs ?? 30000;
    if (
      !Number.isInteger(timeout) ||
      Number(timeout) < 1 ||
      Number(timeout) > 120000
    )
      return invalid("Hook 超时为 1–120000 毫秒。");
    const permissions = item.permissions ?? {};
    if (!object(permissions)) return invalid("permissions 必须是对象。");
    fields(permissions, ["writePaths", "networkDomains"]);
    const writePaths = permissions.writePaths ?? [],
      networkDomains = permissions.networkDomains ?? [];
    if (!strings(writePaths) || !strings(networkDomains))
      return invalid("资源声明必须为字符串数组。");
    if (
      writePaths.some(
        (p) =>
          !p ||
          p.startsWith("/") ||
          p.split(/[\\/]/).includes("..") ||
          p.includes("*"),
      )
    )
      return invalid("写权限仅接受项目内相对路径。");
    if (
      networkDomains.some(
        (d) =>
          !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(d) ||
          /(^|\.)(localhost|local|internal)$/i.test(d),
      )
    )
      return invalid("网络仅支持具体公网域名，禁止通配符、IP 与本机地址。");
    return {
      id: item.id,
      event: item.event as HookEvent,
      enabled: item.enabled !== false,
      packagePath: item.packagePath,
      entry: item.entry,
      interpreter: item.interpreter as HookDefinition["interpreter"],
      args: (item.args ?? []) as string[],
      ...(item.tools === undefined ? {} : { tools: item.tools as string[] }),
      timeoutMs: Number(timeout),
      permissions: { writePaths, networkDomains },
    };
  });
  return { schemaVersion: 1, hooks };
}
/** stdout 是控制协议；stderr 仅作日志，非零退出不能伪装成有效决定。 */
export function parseHookOutput(text: string, event: HookEvent): HookOutput {
  if (new TextEncoder().encode(text).length > 65536)
    return invalid("Hook 标准输出超过 64 KiB。");
  if (!text.trim()) return { decision: "continue" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("Hook 标准输出必须为空或单个 JSON 对象。");
  }
  if (!object(value)) return invalid("Hook 输出必须为对象。");
  fields(value, ["decision", "additionalContext", "reason"]);
  if (!["continue", "deny"].includes(String(value.decision)))
    return invalid("Hook decision 必须是 continue 或 deny。");
  if (
    value.additionalContext !== undefined &&
    typeof value.additionalContext !== "string"
  )
    return invalid("additionalContext 必须是字符串。");
  if (
    value.reason !== undefined &&
    (typeof value.reason !== "string" || !value.reason.trim())
  )
    return invalid("reason 必须为非空字符串。");
  if (
    value.decision === "deny" &&
    (event !== "PreToolUse" ||
      typeof value.reason !== "string" ||
      !value.reason.trim())
  )
    return invalid("只有 PreToolUse 可以拒绝，且须填写 reason。");
  if (event === "RunEnd" && value.additionalContext !== undefined)
    return invalid("RunEnd 不允许向模型补充上下文。");
  return value as unknown as HookOutput;
}
export const matchesHook = (
  hook: FrozenHook,
  event: HookEvent,
  tool?: string,
) =>
  hook.definition.enabled &&
  hook.definition.event === event &&
  (!hook.definition.tools ||
    (tool !== undefined && hook.definition.tools.includes(tool)));
