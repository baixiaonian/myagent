/** Hook 公开协议：固定生命周期事件与配置时授权。脚本输出不能更改原工具回执或扩大权限。 */
import type { ChatError, JsonValue, McpConfigTarget } from "./index.js";
export type HookEvent = "RunStart" | "PreToolUse" | "PostToolUse" | "RunEnd";
export interface HookDefinition {
  id: string;
  event: HookEvent;
  enabled: boolean;
  packagePath: string;
  entry: string;
  interpreter: "node" | "python3" | "sh";
  args: string[];
  tools?: string[];
  timeoutMs: number;
  permissions: { writePaths: string[]; networkDomains: string[] };
}
export interface HookDocument {
  schemaVersion: 1;
  hooks: HookDefinition[];
}
export interface HookConfigView {
  target: McpConfigTarget;
  path: string;
  text: string;
  revision: string;
  /** 配置和所有脚本包内容共同生成；确认不能只绑定 JSON 文件。 */
  version: string;
  document: HookDocument | null;
  packages: { id: string; version: string; interpreterPath: string }[];
  pending: boolean;
  blocking: boolean;
  error: string | null;
}
export interface HookConfigSave extends McpConfigTarget {
  text: string;
  expectedRevision: string;
  /** 用户在预览中看到的配置及包版本；缺失表示仅预览，不写文件或授权。 */
  expectedVersion?: string;
}
export interface HookOutput {
  decision: "continue" | "deny";
  additionalContext?: string;
  reason?: string;
}
export interface HookInput {
  schemaVersion: 1;
  eventId: string;
  event: HookEvent;
  runId: string;
  sessionId: string;
  workspace: { id: string; path: string };
  question: string;
  tool?: {
    invocationId: string;
    name: string;
    arguments: JsonValue;
    result?: JsonValue;
  };
  outcome?: { status: string; error: ChatError | null; answer: string };
}
export interface HookExecution {
  plugin?: import("./plugins.js").PluginOrigin;
  id: string;
  origin: "hook";
  runId: string;
  sessionId: string;
  event: HookEvent;
  trigger: string;
  hookId: string;
  scope: "user" | "project";
  version: string;
  status:
    | "prepared"
    | "running"
    | "succeeded"
    | "failed"
    | "denied"
    | "cancelled"
    | "unknown";
  output: HookOutput | null;
  error: ChatError | null;
  resultRef: string | null;
  logRef: string | null;
  createdAt: string;
  endedAt: string | null;
}
