/** MCP 文档解析与脱敏：统一表单和 JSON 文件的 Schema，错误仅返回安全位置，不回显输入。 */
import {
  AppError,
  type McpConfigDocument,
  type McpConnectionInput,
  type McpServerConfig,
} from "@myagent/contracts";
import { validateMcpInput } from "./mcp.js";

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
const keys = new Set([
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
  "workspaceIds",
]);
const invalid = () =>
  new AppError("invalid_mcp", "MCP 配置字段或类型无效，请按配置示例检查。");
export function parseMcpDocument(text: string): McpConfigDocument {
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : { mcpServers: {} };
  } catch (error) {
    const position =
      error instanceof Error
        ? /position (\d+)/.exec(error.message)?.[1]
        : undefined;
    const before = text.slice(0, Number(position ?? 0));
    throw new AppError(
      "config_json",
      `JSON 格式错误（第 ${before.split("\n").length} 行，第 ${(before.split("\n").at(-1)?.length ?? 0) + 1} 列）。`,
    );
  }
  if (
    !object(value) ||
    Object.keys(value).some((k) => k !== "mcpServers") ||
    !object(value.mcpServers) ||
    Object.keys(value.mcpServers).length > 100
  )
    throw invalid();
  for (const [name, server] of Object.entries(value.mcpServers)) {
    if (
      !/^[\p{L}\p{N}_.-]{1,100}$/u.test(name) ||
      ["__proto__", "constructor", "prototype"].includes(name) ||
      !object(server) ||
      Object.keys(server).some((k) => !keys.has(k))
    )
      throw invalid();
    for (const key of [
      "command",
      "url",
      "token",
      "clientId",
      "clientMetadataUrl",
    ])
      if (
        server[key] !== undefined &&
        (typeof server[key] !== "string" ||
          server[key].length > 8192 ||
          server[key].includes("\0"))
      )
        throw invalid();
    for (const key of ["args", "networkDomains", "workspaceIds"])
      if (
        server[key] !== undefined &&
        (!Array.isArray(server[key]) ||
          server[key].length > 100 ||
          server[key].some(
            (v: unknown) =>
              typeof v !== "string" || v.length > 8192 || v.includes("\0"),
          ))
      )
        throw invalid();
    if (server.enabled !== undefined && typeof server.enabled !== "boolean")
      throw invalid();
    if (
      server.transport !== undefined &&
      !["stdio", "http"].includes(String(server.transport))
    )
      throw invalid();
    if (
      server.auth !== undefined &&
      !["none", "token", "oauth"].includes(String(server.auth))
    )
      throw invalid();
    if (
      server.env !== undefined &&
      (!object(server.env) ||
        Object.keys(server.env).length > 50 ||
        Object.values(server.env).some((v) => typeof v !== "string"))
    )
      throw invalid();
    if (
      server.additionalPaths !== undefined &&
      (!Array.isArray(server.additionalPaths) ||
        server.additionalPaths.length > 10 ||
        server.additionalPaths.some(
          (v) =>
            !object(v) ||
            Object.keys(v).some((k) => !["path", "access"].includes(k)) ||
            typeof v.path !== "string" ||
            !v.path.startsWith("/") ||
            !["read", "write"].includes(String(v.access)),
        ))
    )
      throw invalid();
    validateMcpInput(mcpInput(name, server as McpServerConfig));
  }
  return value as unknown as McpConfigDocument;
}
export function mcpInput(
  name: string,
  server: McpServerConfig,
): McpConnectionInput {
  const { enabled: _, env, token, ...rest } = server;
  return {
    ...rest,
    name,
    transport: server.transport ?? (server.command ? "stdio" : "http"),
    auth: server.auth ?? (token ? "token" : "none"),
    workspaceIds: server.workspaceIds ?? [],
    ...(env ? { environment: env } : {}),
    ...(token ? { token } : {}),
  };
}
export function secretSlot(kind: string): string {
  return `\${secret:${kind}}`;
}
export function sanitizeMcpDocument(document: McpConfigDocument): {
  document: McpConfigDocument;
  containsSecrets: boolean;
} {
  const safe = structuredClone(document);
  let containsSecrets = false;
  for (const server of Object.values(safe.mcpServers)) {
    if (server.token) {
      if (server.token !== secretSlot("token")) containsSecrets = true;
      server.token = secretSlot("token");
    }
    for (const name of Object.keys(server.env ?? {})) {
      if (server.env?.[name] !== secretSlot(`env.${name}`))
        containsSecrets = true;
      if (server.env) server.env[name] = secretSlot(`env.${name}`);
    }
  }
  return { document: safe, containsSecrets };
}
