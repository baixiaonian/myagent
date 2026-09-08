import type {
  ChatError,
  ChatEvent,
  Message,
  ModelSettings,
  Run,
  Session,
  SessionSnapshot,
  Usage,
} from "@myagent/contracts";
export interface StoredSettings extends ModelSettings {
  credentialRef: string | null;
}
export interface CredentialStore {
  read(ref: string): string | null;
  write(ref: string, secret: string): void;
  remove(ref: string): void;
}
export interface BeginRun {
  sessionId: string;
  expectedRevision: number;
  requestId: string;
  fingerprint: string;
  kind: "send" | "regenerate";
  content: string;
  model: string;
  contextTrimmed: boolean;
}
export interface FinishRun {
  status: Exclude<Run["status"], "running">;
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
  createSession(): Session;
  snapshot(id: string): SessionSnapshot;
  renameSession(id: string, title: string, revision: number): Session;
  deleteSession(id: string): void;
  findRequest(sessionId: string, requestId: string): Run | null;
  getRun(id: string): Run;
  beginRun(input: BeginRun): Run;
  appendDelta(runId: string, delta: string): void;
  finishRun(runId: string, outcome: FinishRun): void;
  events(sessionId: string, after: number): ChatEvent[];
  recoverInterrupted(): void;
  close(): void;
}
export function contextBeforeQuestion(
  messages: readonly Message[],
  questionId: string,
): Message[] {
  const index = messages.findIndex((message) => message.id === questionId);
  return index < 0 ? [] : messages.slice(0, index);
}
