/**
 * 受控执行端口：将平台 I/O、参数准备和结果存储留在适配器，应用层只编排契约。
 * prepared 必须由可信实现生成；模型输入不能直接成为资源声明或沙箱权限。
 */
import type {
  ExecutionAttempt,
  ExecutionReceipt,
  JsonValue,
  ProcessSession,
  ResourceAccess,
  ResultPage,
  ResultRef,
  ToolDescriptor,
  Workspace,
} from "@myagent/contracts";

export interface ExecutionContext {
  /** 由应用层从持久 Run 取得；不得取自工具 arguments。 */
  executionMode?: import("@myagent/contracts").ExecutionMode;
  runId: string;
  sessionId: string;
  stepId: string;
  invocationId: string;
  workspace: Workspace | null;
}
export interface PreparedTool {
  /** 注册表决定采用强制只读 Worker；声明只读必须有实际隔离，不能只改锁模式。 */
  readOnlyExecution?: boolean;
  descriptor: ToolDescriptor;
  arguments: Record<string, JsonValue>;
  fingerprint: string;
  resources: ResourceAccess[];
  lockKeys: { key: string; mode: "read" | "write" }[];
}
export interface ToolRegistryPort {
  descriptors(): ToolDescriptor[];
  prepare(
    name: string,
    rawArguments: string,
    context: ExecutionContext,
  ): Promise<PreparedTool>;
  /** 最终派发前重新解析目标路径和定义；返回值不能默默改变已经批准的操作。 */
  revalidate(prepared: PreparedTool, context: ExecutionContext): Promise<void>;
}
export interface DispatchRequest {
  /** 私有脚本动作，由应用层构造；不经过模型工具注册入口。 */
  hook?: {
    interpreterPath: string;
    entryPath: string;
    args: string[];
    input: JsonValue;
    readOnlyPaths: string[];
  };
  attemptId: string;
  prepared: PreparedTool;
  context: ExecutionContext;
  timeoutMs: number;
  authorizedResources: ResourceAccess[];
  /** Worker 已就绪但尚未发送真实动作；调用方先持久化派发身份。 */
  onAccepted?: (workerId: string | null) => Promise<void> | void;
}
export interface ExecutionGateway {
  dispatch(
    request: DispatchRequest,
    signal: AbortSignal,
  ): Promise<ExecutionReceipt>;
  /** 取消单个真实派发，避免一个 Hook 超时误杀同 Run 的业务进程。 */
  cancelAttempt?(attemptId: string): Promise<void>;
  reconcile(
    attemptId: string,
    workerId?: string | null,
  ): Promise<ExecutionReceipt | null>;
  closeRun(runId: string): Promise<{ confirmed: boolean }>;
  processes(runId: string): ProcessSession[];
  recoverProcesses?(records: ProcessSession[]): Promise<void>;
  deleteRecords?(
    attempts: ExecutionAttempt[],
    processes: ProcessSession[],
  ): Promise<void>;
  revoke(workspaceId: string): Promise<void>;
  close(): Promise<void>;
}
export interface ResultStorePort {
  /** 服务端从已保存原文生成模型预览；校验会话归属，不公开文件路径或二进制附件。 */
  preview(
    resultId: string,
    sessionId: string,
    maximum: number,
  ): Promise<{ content: string; truncated: boolean }>;
  save(
    context: ExecutionContext,
    value: JsonValue,
    complete?: boolean,
  ): Promise<{ reference: ResultRef; preview: string; truncated: boolean }>;
  read(
    resultId: string,
    sessionId: string,
    cursor?: string,
    limit?: number,
  ): Promise<ResultPage>;
  deleteSession(sessionId: string): Promise<void>;
}
export interface WorkspacePort {
  create(path: string, name: string): Promise<Workspace>;
  validate(workspace: Workspace): Promise<void>;
}
