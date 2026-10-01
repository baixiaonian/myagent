/** 团队持久事实：内部会话、收件箱、运行关联和待派发意图；事务必须与聊天及工具仓储共用数据库。 */
import type { JsonValue, TeamMember, TeamMessage } from "@myagent/contracts";
export interface TeamScope {
  id: string;
  sessionId: string;
  branchId: string;
  candidate: boolean;
  suspended: boolean;
  resumeMembers?: boolean;
  stopping: boolean;
  finalized: boolean;
  elapsed: number;
  tick: number;
  /** 只兼容读取旧事实；当前程序忽略旧任务总时限与产出上限，不回写成新的限制。 */
  timeLimit?: number;
  outputLimit?: number;
  output: number;
  revision: number;
}
export interface TeamLink {
  id: string;
  sessionId: string;
  rootRunId: string;
  agentId: string;
}
export interface TeamWait {
  id: string;
  sessionId: string;
  rootRunId: string;
  targets: string[];
  targetVersion?: string;
  revision: number;
  until: number;
  completion: boolean;
}
export interface TeamJob {
  error?: { code: string; message: string };
  id: string;
  sessionId: string;
  rootRunId: string;
  agentId: string;
  messageId: string;
  content: string;
  invocationId: string;
  startedRunId: string | null;
}
export interface TeamRecords {
  scopes: TeamScope;
  members: TeamMember;
  messages: TeamMessage;
  links: TeamLink;
  waits: TeamWait;
  jobs: TeamJob;
  seeds: {
    id: string;
    sessionId: string;
    messages: { sourceId: string; content: string }[];
  };
  heads: { id: string; sessionId: string; branchId: string };
  operations: {
    id: string;
    sessionId: string;
    fingerprint: string;
    value: JsonValue;
  };
}
export interface TeamStore {
  get<K extends keyof TeamRecords>(kind: K, id: string): TeamRecords[K] | null;
  list<K extends keyof TeamRecords>(kind: K): TeamRecords[K][];
  put<K extends keyof TeamRecords>(kind: K, value: TeamRecords[K]): void;
  delete(kind: keyof TeamRecords, id: string): void;
  transaction<T>(fn: () => T): T;
  notify(sessionId: string, runId: string): void;
}
