/** 长期记忆公开协议：正文有来源和适用项目，任务用量独立于聊天；不包含模型凭证或私有续接。 */
import type { ApiProtocol } from "./agent.js";
import type { ChatError, Usage } from "./index.js";

export type MemoryKind = "preference" | "project" | "experience" | "decision";
export interface MemorySource {
  id: string;
  sessionId: string;
  recordId: string;
  hash: string;
  createdAt: string;
  status: string;
}
export interface MemoryEntry {
  id: string;
  title: string;
  text: string;
  kind: MemoryKind;
  project: string | null;
  revision: number;
  manual: boolean;
  status: "active" | "needs_review";
  sources: MemorySource[];
  createdAt: string;
  updatedAt: string;
}
export interface MemorySettings {
  revision: number;
  enabled: boolean;
  useMemories: boolean;
  generateMemories: boolean;
  enabledAt: string | null;
  idleMinutes: number;
  dailyRequests: number;
  taskRequests: number;
  requestTimeoutMs: number;
}
export interface SessionMemorySettings {
  id: string;
  revision: number;
  useMemories: boolean;
  contributeMemories: boolean;
}
export interface MemoryQuery {
  query?: string;
  project?: string;
  kind?: MemoryKind;
  cursor?: string;
  limit?: number;
}
export interface MemoryPage {
  entries: MemoryEntry[];
  nextCursor: string | null;
  revision: string;
}
export interface MemoryRead {
  entry: Omit<MemoryEntry, "text">;
  text: string;
  nextCursor: string | null;
  source: MemorySource | null;
  /** 提炼记录的安全投影引用；与来源一起分页，不暴露后台模型输入。 */
  extractions: { id: string; createdAt: string }[];
}
export interface MemoryUpdate {
  requestId: string;
  action: "add" | "edit" | "forget";
  id?: string;
  expectedRevision?: number;
  title?: string;
  text?: string;
  kind?: MemoryKind;
  project?: string | null;
}
export interface MemoryChange {
  id: string;
  createdAt: string;
  reason: string;
  before: MemoryEntry[];
  after: MemoryEntry[];
  undoable: boolean;
}
export type MemoryJobStatus =
  | "queued"
  | "running"
  | "yielded"
  | "waiting_budget"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "stale";
export interface MemoryJobView {
  id: string;
  sessionId: string;
  status: MemoryJobStatus;
  phase: "extract" | "consolidate" | "publish";
  manual: boolean;
  requests: number;
  usage: Usage | null;
  model: string | null;
  apiProtocol: ApiProtocol | null;
  createdAt: string;
  updatedAt: string;
  error: ChatError | null;
}
export interface MemoryOverview {
  settings: MemorySettings;
  revision: string;
  summary: string;
  entryCount: number;
  paths: { memory: string; summary: string; rollouts: string };
  jobs: MemoryJobView[];
  changes: MemoryChange[];
  todayRequests: number;
  usage: Usage | null;
  error: ChatError | null;
}
