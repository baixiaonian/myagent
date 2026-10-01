/** 插件公开协议：组合包、兼容报告和作用域管理；包身份与显示名称分离，公开响应不包含凭证。 */
import type {
  HookDefinition,
  McpConfigTarget,
  McpLiveState,
  McpServerConfig,
} from "./index.js";
export type PluginSource =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; ref?: string; subdirectory?: string };
export interface PluginOrigin {
  /** 受管理的只读包根；不指向应用数据库或凭证目录。 */
  rootPath?: string;
  pluginId: string;
  name: string;
  version: string;
  componentId: string;
}
export interface PluginIssue {
  id: string;
  componentId: string;
  message: string;
  blocking: boolean;
}
export interface PluginComponent {
  id: string;
  kind: "skill" | "mcp" | "hook" | "unsupported";
  name: string;
  path?: string;
  mcp?: McpServerConfig;
  hook?: HookDefinition;
}
export interface PluginManifest {
  name: string;
  description: string;
  declaredVersion: string | null;
  format: "agent" | "codex";
  components: PluginComponent[];
  issues: PluginIssue[];
}
export interface PluginSelection {
  excluded: string[];
  mcp: Record<string, Partial<McpServerConfig>>;
}
export interface PluginReference {
  pluginId: string;
  name: string;
  version: string;
  bindingId: string;
  configurationVersion: string;
}
export interface PluginMutation extends McpConfigTarget {
  requestId: string;
  pluginId?: string;
  expectedRevision: number;
  action: "install" | "update" | "configure" | "rollback";
  source?: PluginSource;
  enabled: boolean;
  selection?: PluginSelection;
}
export interface PluginJob {
  id: string;
  pluginId: string;
  target: McpConfigTarget;
  action: PluginMutation["action"];
  status:
    | "preparing"
    | "ready"
    | "committed"
    | "cancelled"
    | "failed"
    | "interrupted";
  manifest: PluginManifest | null;
  version: string | null;
  commit: string | null;
  source: PluginSource;
  enabled: boolean;
  selection: PluginSelection;
  expectedRevision: number;
  confirmation: string | null;
  error: string | null;
  createdAt: string;
  noChange: boolean;
}
export interface PluginConfirm {
  requestId: string;
  confirmation: string;
  credentials?: Record<
    string,
    { token?: string; environment?: Record<string, string> }
  >;
}
export interface PluginChange extends McpConfigTarget {
  requestId: string;
  expectedRevision: number;
  action: "disable" | "uninstall" | "inherit";
}
export interface PluginView {
  pluginId: string;
  name: string;
  description: string;
  source: PluginSource;
  target: McpConfigTarget;
  revision: number;
  inherited: boolean;
  enabled: boolean;
  removed: boolean;
  version: string;
  declaredVersion: string | null;
  previousVersion: string | null;
  commit: string | null;
  selection: PluginSelection;
  manifest: PluginManifest;
  status:
    | "enabled"
    | "disabled"
    | "installed"
    | "configuration_required"
    | "degraded"
    | "pending_cleanup";
  activeRunIds: string[];
  connections: {
    componentId: string;
    connectionId: string;
    workspaceId: string;
    state: McpLiveState;
  }[];
}
