/**
 * 工具执行跨边界协议：描述资源、授权、调用、进程与结果，供 Server、Worker 和 Web 使用。
 * 调用 ID 仅关联消息；invocationId/attemptId 分别关联逻辑操作和真实派发，不代表远端业务幂等。
 * 凭证值、恢复上下文和厂商续接材料不属于这些公开 DTO。
 */
import type { CommandAssessment } from "./commands.js";
import type {
  ChatError,
  JsonValue,
  ToolDefinition,
  ToolResult,
} from "./index.js";

export interface Workspace {
  id: string;
  name: string;
  path: string;
  /** 规范路径及目录身份摘要，用于发现目录替换，不能只比较用户输入的路径字符串。 */
  identity: string;
  createdAt: string;
  kind?: "project" | "default" | "diagnostic";
  lastUsedAt?: string;
}
export type ResourceAccess =
  | { kind: "path"; target: string; access: "read" | "write" }
  | { kind: "network"; target: string; access: "connect" }
  | { kind: "mcp"; target: string; access: "call" };
export interface ToolDescriptor extends ToolDefinition {
  version: string;
  source:
    | { kind: "local" }
    | {
        kind: "mcp";
        connectionId: string;
        originalName: string;
        executionMode?: import("./index.js").ExecutionMode;
        workspaceId?: string;
      };
  effects: "read" | "write" | "unknown";
  concurrency: "shared" | "exclusive" | "control";
  requiresWorkspace: boolean;
}
export interface PermissionGrant {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  scope: "once" | "session" | "workspace";
  decision: "allow" | "deny";
  resources: ResourceAccess[];
  /** 单次批准绑定最终参数摘要；目录和 MCP 版本变化仍需重新校验。 */
  fingerprint: string | null;
  invocationId: string | null;
  createdAt: string;
  revokedAt: string | null;
  toolVersion?: string;
}
export interface ApprovalRequest {
  /** 缺失表示旧资源审批；出现时只允许批准本次完整命令。 */
  command?: CommandAssessment;
  id: string;
  sessionId: string;
  runId: string;
  workspaceId: string;
  invocationId: string;
  toolName: string;
  arguments: JsonValue;
  fingerprint: string;
  resources: ResourceAccess[];
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  decision?: ApprovalDecision;
  toolVersion?: string;
}
export interface ApprovalDecision {
  requestId: string;
  decision: "allow" | "deny";
  scope: "once" | "session" | "workspace";
}
export type InvocationStatus =
  | "prepared"
  | "waiting_approval"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled"
  | "unknown";
export interface ToolInvocation {
  /** 真实执行采用的用户权限快照，完整访问不伪造一次批准。 */
  executionMode?: import("./index.js").ExecutionMode;
  origin?: "tool";
  command?: CommandAssessment;
  id: string;
  sessionId: string;
  runId: string;
  stepId: string;
  callId: string;
  ordinal: number;
  toolName: string;
  toolVersion: string;
  source: ToolDescriptor["source"];
  arguments: string;
  fingerprint: string;
  resources: ResourceAccess[];
  effects: ToolDescriptor["effects"];
  status: InvocationStatus;
  result: ToolResult | null;
  createdAt: string;
  endedAt: string | null;
  resolution?: {
    kind:
      | "acknowledged_unknown"
      | "confirmed_executed"
      | "confirmed_not_executed";
    note: string;
    at: string;
  };
}
/** 删除会话后只保留未核对动作的最小隔离记录，不保留问题、参数、密钥和完整结果。 */
export interface ExecutionConcern {
  id: string;
  workspaceId: string;
  sourceSessionId: string;
  toolName: string;
  source: ToolDescriptor["source"];
  resources: ResourceAccess[];
  createdAt: string;
  resolution?: NonNullable<ToolInvocation["resolution"]>;
}
export interface ExecutionAttempt {
  /** 接收动作前的持久屏障；缺失不代表已经实际派发。 */
  acceptedAt?: string;
  origin?: "tool" | "hook";
  id: string;
  invocationId: string;
  sessionId: string;
  runId: string;
  status: "dispatching" | "accepted" | "completed" | "unknown";
  workerId: string | null;
  startedAt: string;
  endedAt: string | null;
}
export interface ExecutionReceipt {
  attemptId: string;
  invocationId: string;
  outcome: "succeeded" | "failed" | "cancelled" | "unknown";
  data: JsonValue;
  error: ChatError | null;
  /** 已知失败/确认停止也可能已经产生部分副作用。 */
  effectsPossible: boolean;
  completedAt: string;
}
export interface ResultRef {
  id: string;
  sessionId: string;
  runId: string;
  invocationId: string;
  bytes: number;
  sha256: string;
  mimeType: string;
  captureComplete: boolean;
  /** 未完整采集时总丢失量可能不可知；bytes/totalBytes 表示实际保存范围。 */
  omittedBytes?: number | null;
  captureReason?: "complete" | "capture_incomplete";
  createdAt: string;
}
export interface ResultPage {
  resultId: string;
  text: string;
  cursor: string | null;
  totalBytes: number;
  captureComplete: boolean;
  /** 未完整采集时总丢失量可能不可知；bytes/totalBytes 表示实际保存范围。 */
  omittedBytes?: number | null;
  captureReason?: "complete" | "capture_incomplete";
}
export interface ProcessSession {
  /** Worker 在同一进程中用单调时钟测得的运行时长；旧记录/未知终态可缺失。 */
  durationMs?: number;
  id: string;
  sessionId: string;
  runId: string;
  invocationId: string;
  workerId: string;
  pid: number;
  birthTime?: string;
  outputComplete?: boolean;
  status: "running" | "exited" | "stopped" | "unknown";
  exitCode: number | null;
  signal: string | null;
  outputRef: string;
  createdAt: string;
  endedAt: string | null;
}
/** 仅决定工具定义何时提供给模型，不改变连接启用、信任或执行权限。 */
export type McpToolExposure = "deferred" | "direct";
export interface McpConnection {
  plugin?: import("./plugins.js").PluginOrigin;
  id: string;
  name: string;
  transport: "stdio" | "http";
  /** 旧版持久记录可缺省，读取时按 deferred 解释。 */
  toolExposure?: McpToolExposure;
  command: string;
  args: string[];
  networkDomains: string[];
  additionalPaths: { path: string; access: "read" | "write" }[];
  url: string;
  workspaceIds: string[];
  /** 仅记录环境变量名；明文在服务端凭证仓储中，读取连接不会泄露引用。 */
  environmentNames: string[];
  auth: "none" | "token" | "oauth";
  clientId: string;
  clientMetadataUrl: string;
  status: "disconnected" | "connected" | "authorization_required" | "error";
  revision: number;
  createdAt: string;
}
export interface McpRemoval {
  localRemoved: true;
  remoteRevocation: "succeeded" | "failed" | "unsupported" | "not_applicable";
}
export interface McpConnectionInput {
  name: string;
  transport: "stdio" | "http";
  toolExposure?: McpToolExposure;
  command?: string;
  args?: string[];
  networkDomains?: string[];
  additionalPaths?: { path: string; access: "read" | "write" }[];
  url?: string;
  workspaceIds: string[];
  auth: "none" | "token" | "oauth";
  token?: string;
  environment?: Record<string, string>;
  clientId?: string;
  clientMetadataUrl?: string;
  expectedRevision?: number;
}
export interface ExecutionOverview {
  workspace: Workspace | null;
  approvals: ApprovalRequest[];
  invocations: ToolInvocation[];
  processes: ProcessSession[];
  concerns: ExecutionConcern[];
}
/** 资源限制与模型轮数无关；完整结果额度和模型实际输入额度分别计量。 */
export const EXECUTION_LIMITS = {
  runConcurrency: 4,
  globalConcurrency: 8,
  toolTimeoutMs: 30000,
  terminationGraceMs: 2000,
  approvalTimeoutMs: 86400000,
  resultBytes: 20 * 1024 * 1024,
  runResultBytes: 100 * 1024 * 1024,
  resultCharacters: 8000,
} as const;
export const ACTIVE_RUN_STATUSES = [
  "running",
  "waiting_approval",
  "waiting_agents",
  "waiting_context",
  "waiting_reconciliation",
  "recoverable",
  "cleaning",
] as const;
export function isActiveRun(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}
