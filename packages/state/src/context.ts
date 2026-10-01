/**
 * 上下文派生状态仓储：原消息和工具事实不迁入此处；只保存来源、摘要和请求清单。
 * 原始续接只留在 StoredStep；这里的摘要输入必须是已去除厂商私有字段的语义投影。
 */
import type {
  ContextCapacity,
  ContextView,
  HistoryPage,
  HistoryQuery,
  JsonValue,
  Usage,
} from "@myagent/contracts";
export interface ContextSource {
  id: string;
  hash: string;
}
export interface ContextRecordBase {
  id: string;
  sessionId: string;
  runId: string;
}
export interface ContextSummaryRecord extends ContextRecordBase {
  published?: boolean;
  templateVersion: number;
  text: string;
  sources: ContextSource[];
  identity: string;
  instructionsHash: string;
  segment: "history" | "current";
  createdAt: string;
  previewBased: boolean;
}
export interface ContextRunRecord extends ContextRecordBase {
  view: ContextView;
  capacity: ContextCapacity;
  identity: string;
  instructionsHash: string;
  rules: string;
  memory: string;
  memoryLoaded: boolean;
  /** 同一 Run 只取一次概览，后续只撤销失效项，不自动换入新版本。 */
  memoryPieces?: {
    sourceId: string;
    version: string;
    scope: string;
    text: string;
  }[];
  summaryIds: string[];
  automaticDisabled: boolean;
  force: boolean;
  generation: number;
  resumeRequests: Record<string, string>;
  summaryOutputCharacters: number;
  legacyCharacterLimit: number | null;
  /** 按执行边界追加的状态投影引用；正文在 artifacts，旧检查点缺省为空。 */
  executionNotes?: { id: string; afterSourceId: string }[];
  /** 已缩小的工具预览不能下一请求恢复为大预览，破坏历史前缀。 */
  previewLimits?: Record<string, number>;
}
export interface ContextJob extends ContextRecordBase {
  generation: number;
  sources: ContextSource[];
  status: "running" | "completed" | "failed" | "interrupted";
  draft: string;
  nextChunk: number;
  usage: Usage | null;
  error: string | null;
  createdAt: string;
}
export interface ContextManifest extends ContextRecordBase {
  /** 可重建的来源元数据，用于相邻准备结果比较；不保存正文或私有续接。旧记录不补造。 */
  components?: {
    id: string;
    kind: string;
    label: string;
    hash: string;
    characters: number;
  }[];
  messageHash: string;
  version: number;
  sources: ContextSource[];
  summaryIds: string[];
  toolSnapshotId: string;
  projectedSources: string[];
  estimatedTokens: number;
  createdAt: string;
}
export interface ContextArtifact extends ContextRecordBase {
  value: JsonValue;
}
export interface ContextRecords {
  runs: ContextRunRecord;
  summaries: ContextSummaryRecord;
  jobs: ContextJob;
  manifests: ContextManifest;
  artifacts: ContextArtifact;
}
export interface ContextStore {
  get<K extends keyof ContextRecords>(
    kind: K,
    id: string,
  ): ContextRecords[K] | null;
  list<K extends keyof ContextRecords>(
    kind: K,
    sessionId: string,
  ): ContextRecords[K][];
  put<K extends keyof ContextRecords>(kind: K, record: ContextRecords[K]): void;
  transaction<T>(operation: () => T): T;
  history(sessionId: string, query: HistoryQuery): HistoryPage;
  recover(): void;
}
export interface ProjectRules {
  text: string;
  path: string;
  hash: string;
  bytes: number;
}
export interface ProjectRulesPort {
  read(root: string): ProjectRules | null;
}
