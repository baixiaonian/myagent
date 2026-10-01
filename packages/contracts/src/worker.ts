/**
 * Server 与执行 Worker 的私有 IPC 信封：固定方法集合、随机请求 ID 和不可变沙箱配置。
 * 仅用于父子进程通信，不经 Web API 返回；工具参数不作为进程命令行参数传播。
 */
import type {
  ExecutionReceipt,
  JsonValue,
  ProcessSession,
  ResourceAccess,
  Workspace,
} from "./index.js";
export interface WorkerConfiguration {
  /** 初始化时冻结；完全访问明确绕过 OS 沙箱，不是沙箱失败后的回退。 */
  executionMode?: import("./index.js").ExecutionMode;
  origin?: "tool" | "hook";
  workerId: string;
  workspace: Workspace;
  resources: ResourceAccess[];
  protectedPaths: string[];
  /** 当前 Run 的受信只读技能副本；即使父目录可写也明确禁止写入。 */
  readOnlyPaths?: string[];
  /** 完全访问的 HOME 由父进程提供，标准模式仍用独立临时 HOME。 */
  userHome?: string;
  runtimeRoot: string;
  actionPath: string;
  recordDir: string;
  scratchDir: string;
}
export interface WorkerExecution {
  /** 仅由已授权 Hook 服务生成，模型参数不能设置此字段。 */
  hook?: {
    interpreterPath: string;
    entryPath: string;
    args: string[];
    input: JsonValue;
  };
  attemptId: string;
  invocationId: string;
  runId: string;
  sessionId: string;
  name: string;
  arguments: Record<string, JsonValue>;
  resources: ResourceAccess[];
  timeoutMs: number;
}
export type WorkerRequest =
  | { id: string; method: "initialize"; configuration: WorkerConfiguration }
  | { id: string; method: "execute"; execution: WorkerExecution }
  | { id: string; method: "cancel"; attemptId: string }
  | {
      id: string;
      method: "mcp_connect";
      command: string;
      args: string[];
      environment: Record<string, string>;
    }
  | { id: string; method: "mcp_list" }
  | { id: string; method: "mcp_call"; execution: WorkerExecution }
  | { id: string; method: "close" };
export interface WorkerReply {
  id: string;
  ok: boolean;
  data?: JsonValue;
  receipt?: ExecutionReceipt;
  error?: { code: string; message: string };
}
export interface WorkerProcessEvent {
  type: "process";
  process: ProcessSession;
  outputPath: string;
}

/** stdio 目录变化仅通知重新发现，不携带或执行远端指令。 */
export interface WorkerCatalogEvent {
  type: "mcp_catalog_changed";
}
