/** 跨进程公开协议。密钥只出现在写入命令，不出现在读取结果或事件。 */
export type RunStatus =
  | "running"
  | "succeeded"
  | "cancelled"
  | "failed"
  | "interrupted";
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
export interface Session {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
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
export interface PublicSettings extends ModelSettings {
  hasKey: boolean;
  keyMask: string;
  configured: boolean;
}
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
export type ChatEvent = EventData & {
  schemaVersion: 1;
  sessionId: string;
  seq: number;
  createdAt: string;
};
export const LIMITS = {
  inputCharacters: 8000,
  contextCharacters: 32000,
  contextTurns: 20,
  timeoutMs: 120000,
  systemCharacters: 4000,
} as const;
