/** 长期记忆持久端口：Markdown 是正文事实源，SQLite 条目只是可重建投影；提交日志保证文件发布可恢复。 */
import type {
  MemoryChange,
  MemoryEntry,
  MemoryJobView,
  MemorySettings,
  MemorySource,
  SessionMemorySettings,
  Usage,
} from "@myagent/contracts";
import type { StoredSettings } from "./index.js";

export interface MemoryDocument {
  text: string;
  revision: string;
  entries: MemoryEntry[];
}
export interface MemoryFiles {
  readonly paths: { memory: string; summary: string; rollouts: string };
  read(): Promise<MemoryDocument>;
  render(entries: MemoryEntry[]): string;
  parse(text: string): MemoryEntry[];
  hash(text: string): string;
  write(text: string, expectedRevision: string): Promise<string>;
  derived(
    summary: string,
    rollout?: { id: string; text: string },
  ): Promise<void>;
  removeRollouts(sessionId: string): Promise<void>;
}
export interface MemoryCandidate {
  title: string;
  text: string;
  kind: MemoryEntry["kind"];
  project: string | null;
  sources: MemorySource[];
}
export interface MemoryInput {
  source: MemorySource;
  text: string;
}
export interface MemoryJob extends MemoryJobView {
  fingerprint: string;
  /** 只保留引用用于自动增量选取；完成后不保留整份原始输入副本。 */
  coveredSourceIds: string[];
  input: MemoryInput[];
  chunks: MemoryInput[][];
  nextChunk: number;
  candidates: MemoryCandidate[];
  nextCandidate: number;
  draft: MemoryEntry[];
  baseRevision: string;
  connection: StoredSettings | null;
  policy: MemorySettings;
  callRecords: {
    id: string;
    phase: string;
    startedAt: string;
    endedAt: string | null;
    usage: Usage | null;
    status: "running" | "completed" | "failed" | "interrupted";
  }[];
}
export interface MemoryCommit {
  id: string;
  expectedRevision: string;
  text: string;
  entries: MemoryEntry[];
  summary: string;
  change: MemoryChange;
  operation: {
    id: string;
    fingerprint: string;
    result: MemoryEntry | null;
  } | null;
  tombstones: MemoryTombstone[];
  rollout: { id: string; text: string } | null;
  jobId: string | null;
  previousText: string;
}
export interface MemoryTombstone {
  id: string;
  sourceIds: string[];
  entryIds: string[];
  sessionId: string | null;
  createdAt: string;
}
export interface MemoryRecords {
  settings: MemorySettings & { id: string };
  sessions: SessionMemorySettings;
  entries: MemoryEntry;
  jobs: MemoryJob;
  changes: MemoryChange;
  commits: MemoryCommit;
  tombstones: MemoryTombstone;
  operations: { id: string; fingerprint: string; result: MemoryEntry | null };
  usage: { id: string; requests: number; usage: Usage | null };
  meta: {
    id: string;
    revision: string;
    summary: string;
    error: { code: string; message: string } | null;
  };
  access: { id: string; count: number; at: string };
  jobRequests: {
    id: string;
    sessionId: string;
    manual: boolean;
    jobId: string;
  };
  rebuild: { id: string; createdAt: string };
}
export interface MemoryStore {
  get<K extends keyof MemoryRecords>(
    kind: K,
    id: string,
  ): MemoryRecords[K] | null;
  list<K extends keyof MemoryRecords>(kind: K): MemoryRecords[K][];
  put<K extends keyof MemoryRecords>(kind: K, record: MemoryRecords[K]): void;
  remove(kind: keyof MemoryRecords, id: string): void;
  transaction<T>(operation: () => T): T;
}
