/**
 * 跨模块、跨进程共享的数据协议：定义会话、消息、运行、设置、命令、事件和安全错误。
 * 只承载类型与通用限制，不依赖 HTTP、数据库或模型 SDK；字段变化需同步协议与迁移。
 * 密钥只能出现在设置写入命令中，读取结果和事件均不能携带明文。
 */
export type RunStatus =
  | "running"
  | "succeeded"
  | "cancelled"
  | "failed"
  | "interrupted";
// superseded 仅标记重新生成成功后被替换的旧答；它仍保留在历史记录中。
export type MessageStatus =
  | "generating"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "superseded";
export interface ChatError {
  code: string;
  message: string;
}
// 可跨应用边界传递的安全错误；message 必须可直接展示，不能附带厂商原始异常或密钥。
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}
// revision 是乐观并发版本，创建 / 终结运行或重命名时推进；不是 SSE 事件游标。
export interface Session {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
// replyToId 把多个候选回答关联到同一用户问题，重新生成无需复制问题。
export interface Message {
  id: string;
  sessionId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  replyToId: string | null;
  createdAt: string;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
// 一次发送或重新生成的持久执行记录；原答引用用于成功替换，指纹用于识别重复命令。
export interface Run {
  id: string;
  sessionId: string;
  requestId: string;
  fingerprint: string;
  kind: "send" | "regenerate";
  status: RunStatus;
  userMessageId: string;
  assistantMessageId: string;
  originalAssistantId: string | null;
  model: string;
  contextTrimmed: boolean;
  finishReason: string | null;
  usage: Usage | null;
  error: ChatError | null;
  createdAt: string;
  endedAt: string | null;
}
export interface ModelSettings {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  revision: number;
  updatedAt: string;
}
// 读取设置的唯一公开形态：只给固定掩码与是否可用，不返回原密钥或凭证文件引用。
export interface PublicSettings extends ModelSettings {
  hasKey: boolean;
  keyMask: string;
  configured: boolean;
}
// apiKey 缺省表示保留；clearKey 明确表示删除。两者不能同时提交。
export interface SettingsInput {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  expectedRevision: number;
  apiKey?: string;
  clearKey?: boolean;
}
export interface RunInput {
  requestId: string;
  expectedRevision: number;
  content: string;
}
export interface RegenerateInput {
  requestId: string;
  expectedRevision: number;
}
// cursor 对应这个完整快照已经包含的最后事件；随后只应用更大的事件序号。
export interface SessionSnapshot {
  session: Session;
  messages: Message[];
  latestRun: Run | null;
  activeRun: Run | null;
  cursor: number;
}
export interface RunAccepted {
  run: Run;
  snapshot: SessionSnapshot;
}
export type EventData =
  | { type: "session.updated"; session: Session }
  | { type: "message.created" | "message.updated"; message: Message }
  | { type: "message.delta"; messageId: string; delta: string }
  | { type: "run.updated"; run: Run };
// seq 在单会话内单调递增；schemaVersion 是事件格式版本，不是会话 revision。
export type ChatEvent = EventData & {
  schemaVersion: 1;
  sessionId: string;
  seq: number;
  createdAt: string;
};
// 统一字符和时间限制，供边界及内核复用；字符数不是精确 token 数。
export const LIMITS = {
  inputCharacters: 8000,
  contextCharacters: 32000,
  contextTurns: 20,
  timeoutMs: 120000,
  systemCharacters: 4000,
} as const;
