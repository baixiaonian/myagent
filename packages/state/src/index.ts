/**
 * 状态边界：定义聊天仓储、独立凭证仓储及运行开始 / 终结的输入契约。
 * 具体驱动位于 adapters；这里说明状态所有权及原子性要求，不执行网络或数据库操作。
 */
import type {
  ApiProtocol,
  ChatError,
  ChatEvent,
  JsonValue,
  Message,
  ModelSettings,
  Run,
  RunStep,
  Session,
  SessionSnapshot,
  Usage,
  Workspace,
} from "@myagent/contracts";

export * from "./execution.js";
// 数据库只保存不透明凭证引用；明文由 CredentialStore 单独管理，不能混入消息与事件。
export interface StoredSettings extends ModelSettings {
  credentialRef: string | null;
}
export interface CredentialStore {
  read(ref: string): string | null;
  write(ref: string, secret: string): void;
  remove(ref: string): void;
}
// 运行开始的事务输入；expectedRevision 来自用户看到的会话，fingerprint 用于幂等负载校验。
export interface BeginRun {
  executionMode?: import("@myagent/contracts").ExecutionMode;
  origin?: Message["origin"];
  apiProtocol?: ApiProtocol;
  sessionId: string;
  expectedRevision: number;
  requestId: string;
  fingerprint: string;
  kind: "send" | "regenerate";
  content: string;
  model: string;
  contextTrimmed: boolean;
}
/** 仅供服务端读取；公开快照必须只提取 step，不能展开私有记录。 */
export interface StoredStep {
  step: RunStep;
  identity: string;
  continuation: JsonValue | null;
}
// 终结输入不允许 running；错误和 usage 均可为空，未上报用量不能伪造为零。
export interface FinishRun {
  status: "succeeded" | "failed" | "cancelled" | "interrupted";
  finishReason: string | null;
  usage: Usage | null;
  error: ChatError | null;
}
/** 同步方法在单机 SQLite 事务内完成；不可在事务中等待模型或网络。 */
export interface ChatStore {
  settings(): StoredSettings;
  saveSettings(
    settings: Omit<StoredSettings, "updatedAt" | "revision">,
    expectedRevision: number,
  ): StoredSettings;
  listSessions(): Session[];
  createSession(input?: {
    id: string;
    workspace?: Workspace;
    parentSessionId?: string;
    requestId?: string;
    fingerprint?: string;
  }): Session;
  findSessionCreation?(requestId: string, fingerprint: string): Session | null;
  // 实现必须保证消息、运行状态与 cursor 同事务读取。
  snapshot(id: string): SessionSnapshot;
  renameSession(id: string, title: string, revision: number): Session;
  deleteSession(id: string): void;
  findRequest(sessionId: string, requestId: string): Run | null;
  getRun(id: string): Run;
  getSteps(runId: string): StoredStep[];
  saveStep(record: StoredStep): boolean;
  appendStepDelta(runId: string, stepId: string, delta: string): boolean;
  markContextTrimmed(runId: string): void;
  // 实现必须原子创建问题、候选回答、Run 及开始事件，同时拒绝并发运行和旧版本命令。
  beginRun(input: BeginRun): Run;
  // 增量内容和事件同事务保存；已经终结或删除的 Run 忽略迟到结果。
  appendDelta(runId: string, delta: string): void;
  finishRun(runId: string, outcome: FinishRun): void;
  events(sessionId: string, after: number): ChatEvent[];
  // 仅修补状态，不重放模型调用或其他外部动作。
  recoverInterrupted(): void;
  close(): void;
}
// 重新生成使用问题之前的历史；返回空数组表示目标不存在，由上层决定如何处理。
export function contextBeforeQuestion(
  messages: readonly Message[],
  questionId: string,
): Message[] {
  const index = messages.findIndex((message) => message.id === questionId);
  return index < 0 ? [] : messages.slice(0, index);
}

export * from "./commands.js";
export * from "./context.js";
export * from "./documents.js";
export * from "./hooks.js";
export * from "./memory.js";
export * from "./observability.js";
export * from "./plugins.js";
export * from "./projects.js";
export * from "./skills.js";
export * from "./teams.js";
