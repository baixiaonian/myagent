/** Hook 状态仓储：配置授权、文件提交日志、Run 快照与执行事件共享 SQLite 事务；正文来自配置和包文件。 */
// 状态层不反向依赖 extensions；快照采用独立可序列化结构，由应用层与文件端口检查。
import type {
  HookDefinition,
  HookExecution,
  HookInput,
  McpConfigTarget,
  ResourceAccess,
} from "@myagent/contracts";
import type { FinishRun } from "./index.js";
export interface StoredHook {
  plugin?: import("@myagent/contracts").PluginOrigin;
  id: string;
  scope: "user" | "project";
  definition: HookDefinition;
  version: string;
  package: {
    version: string;
    body: string;
    runtimePath: string;
    files: { path: string; hash: string; bytes: number; binary: boolean }[];
  };
  interpreterPath: string;
  interpreterIdentity: string;
}
export interface HookFileState {
  id: string;
  target: McpConfigTarget;
  trustedVersion: string | null;
  trustedHooks: StoredHook[];
  staged?: { text: string; version: string; hooks: StoredHook[] };
}
export interface HookRun {
  id: string;
  runId: string;
  sessionId: string;
  hooks: StoredHook[];
  /** 业务结果先持久化；清理恢复只执行未完成收尾，不重放模型。 */
  pendingOutcome?: FinishRun;
  endStartedAt?: string;
  endMilliseconds?: number;
}
export interface HookRecord extends HookExecution {
  input: HookInput;
  resources: ResourceAccess[];
  attemptId: string | null;
  workerId: string | null;
  applied: boolean;
}
export interface HookRecords {
  files: HookFileState;
  runs: HookRun;
  events: HookRecord;
}
export interface HookStore {
  get<K extends keyof HookRecords>(kind: K, id: string): HookRecords[K] | null;
  list<K extends keyof HookRecords>(
    kind: K,
    filter?: { sessionId?: string; runId?: string },
  ): HookRecords[K][];
  put<K extends keyof HookRecords>(kind: K, record: HookRecords[K]): void;
  transaction<T>(fn: () => T): T;
}
