/**
 * 工具状态仓储契约：审批、真实执行和恢复资料统一由 Application 经此端口保存。
 * 记录采用类型化集合，具体数据库和事务在适配层；私有连接和检查点不能直接返回 Web。
 */
import type {
  AgentLimits,
  ApprovalRequest,
  ExecutionAttempt,
  ExecutionConcern,
  JsonValue,
  McpConfigDocument,
  McpConfigTarget,
  McpConnection,
  PermissionGrant,
  ProcessSession,
  ResultRef,
  RunStatus,
  ToolInvocation,
  Workspace,
} from "@myagent/contracts";
import type { CommandFileState } from "./commands.js";
import type { StoredSettings } from "./index.js";

export interface StoredMcpConnection extends McpConnection {
  pluginBinding?: string;
  pluginScope?: "user" | "project";
  pluginReadOnlyPaths?: string[];
  credentialRef: string | null;
  environmentRefs: Record<string, string>;
  oauthRef: string | null;
  source?: McpConfigTarget & { key: string; fileId: string };
  enabled?: boolean;
  blocked?: boolean;
  allowedWorkspaces?: string[];
}
export interface RunCheckpoint {
  id: string;
  runId: string;
  sessionId: string;
  settings: StoredSettings;
  limits: AgentLimits;
  instructions: string;
  current: JsonValue;
  history: JsonValue;
  runtime: JsonValue | null;
  loadedTools: string[];
  /** 工具名称仅为兼容投影；有版本绑定的定义才可在后续模型请求中复用。 */
  loadedToolBindings?: LoadedMcpTool[];
  /** 只统计实际活动时间，不再作为任务恢复或维护的截止条件。 */
  activeMilliseconds: number;
  updatedAt: string;
}
/** 按需发现的引用，不保存 Schema、凭证或授权；真实定义始终从当前注册表取得。 */
export interface LoadedMcpTool {
  name: string;
  version: string;
  connectionId: string;
  connectionRevision: number;
  definitionChars: number;
}
/** 会话独享的发现缓存；Run 检查点保存本轮副本，删除会话时随外键级联清理。 */
export interface SessionToolSelection {
  id: string;
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  tools: LoadedMcpTool[];
  updatedAt: string;
}
export interface McpFileState {
  id: string;
  target: McpConfigTarget;
  appliedHash: string;
  document: McpConfigDocument;
  staged?: {
    text: string;
    previousRevision: string;
    connections: StoredMcpConnection[];
    newRefs: string[];
  };
}
export interface ExecutionRecords {
  commandFiles: CommandFileState;
  sessionTools: SessionToolSelection;
  mcpFiles: McpFileState;
  workspaces: Workspace;
  grants: PermissionGrant;
  approvals: ApprovalRequest;
  invocations: ToolInvocation;
  attempts: ExecutionAttempt;
  processes: ProcessSession;
  results: ResultRef;
  connections: StoredMcpConnection;
  checkpoints: RunCheckpoint;
  concerns: ExecutionConcern;
}
export interface RecordFilter {
  sessionId?: string;
  runId?: string;
}
export interface ExecutionFactIndex {
  effects: number;
  unresolved: number;
  activeProcesses: number;
  invocations: {
    sourceId: string;
    tool: string;
    status: string;
    resultRef: string | null;
  }[];
  processes: { id: string; status: string }[];
  more: boolean;
}
export interface ExecutionStore {
  /** 数据库聚合并限制明细数量，禁止每次模型请求物化全会话执行历史。 */
  contextFacts(sessionId: string): ExecutionFactIndex;
  get<K extends keyof ExecutionRecords>(
    kind: K,
    id: string,
  ): ExecutionRecords[K] | null;
  list<K extends keyof ExecutionRecords>(
    kind: K,
    filter?: RecordFilter,
  ): ExecutionRecords[K][];
  /** 有会话归属的记录只允许写入仍存在的会话；关键记录和 SSE 事件同事务提交。 */
  put<K extends keyof ExecutionRecords>(
    kind: K,
    record: ExecutionRecords[K],
  ): void;
  remove<K extends keyof ExecutionRecords>(kind: K, id: string): void;
  transaction<T>(operation: () => T): T;
  bindWorkspace(
    sessionId: string,
    workspaceId: string,
    expectedRevision: number,
  ): void;
  setRunStatus(runId: string, status: RunStatus): void;
  /** 仅用户核对可更新已结束运行的未知结果；普通 put 仍拒绝迟到执行写入。 */
  resolveInvocation(
    id: string,
    resolution: NonNullable<ToolInvocation["resolution"]>,
  ): ToolInvocation;
}
