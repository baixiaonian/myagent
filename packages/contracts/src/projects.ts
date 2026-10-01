/**
 * 项目与 MCP 管理公开契约：Web 经 SDK 消费目录选择、配置来源和实时连接信息。
 * 配置中的 secret 标记是连接内的逻辑槽位，不包含服务端凭证 ID 或已保存的明文。
 */
import type { McpToolExposure, ToolDefinition, Workspace } from "./index.js";

export interface CreateSessionInput {
  requestId?: string;
  path?: string;
}
export interface DirectorySelection {
  status: "selected" | "cancelled" | "unavailable";
  path?: string;
  message?: string;
}
export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: string[];
}
export type McpScope = "user" | "project";
export interface McpConfigTarget {
  scope: McpScope;
  workspaceId?: string;
}
export interface McpServerConfig {
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled?: boolean;
  /** deferred 按需加载（默认）；direct 在每次模型请求直接提供本服务工具定义。 */
  toolExposure?: McpToolExposure;
  auth?: "none" | "token" | "oauth";
  token?: string;
  env?: Record<string, string>;
  clientId?: string;
  clientMetadataUrl?: string;
  networkDomains?: string[];
  additionalPaths?: { path: string; access: "read" | "write" }[];
  /** 只用于保留旧版配置的工作区限制；省略表示用户级供所有项目使用。 */
  workspaceIds?: string[];
}
export interface McpConfigDocument {
  mcpServers: Record<string, McpServerConfig>;
}
export interface McpConfigView {
  target: McpConfigTarget;
  path: string;
  revision: string;
  document: McpConfigDocument | null;
  error: string | null;
  pending: boolean;
  containsSecrets: boolean;
  appliedDocument: McpConfigDocument | null;
}
export type McpLiveStatus =
  | "disabled"
  | "pending"
  | "disconnected"
  | "connecting"
  | "connected"
  | "authorization_required"
  | "error";
export interface McpLiveState {
  status: McpLiveStatus;
  tools: ToolDefinition[];
  error: string | null;
  authorizationUrl?: string;
}
export interface McpServerView extends McpLiveState {
  plugin?: import("./plugins.js").PluginOrigin;
  id: string;
  name: string;
  scope: McpScope;
  workspaceId: string | null;
  enabled: boolean;
  overridden: boolean;
  config: McpServerConfig;
}
export interface McpOverview {
  workspace: Workspace;
  diagnostic: boolean;
  servers: McpServerView[];
  configs: McpConfigView[];
}
/** 管理请求允许新录入的秘密；响应中的相同字段必须先转换为逻辑引用。 */
export interface McpConfigSave extends McpConfigTarget {
  expectedRevision: string;
  document: McpConfigDocument;
  convertSecrets?: boolean;
}
export interface McpConfigConfirmation extends McpConfigTarget {
  expectedRevision: string;
  convertSecrets?: boolean;
}
