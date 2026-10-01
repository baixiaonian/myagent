/** 插件持久记录：不可变包是内容来源，SQLite 保存作用域、发布意图与 Run 引用；不保存明文密钥。 */
import type {
  McpConfigTarget,
  PluginJob,
  PluginManifest,
  PluginReference,
  PluginSelection,
  PluginSource,
} from "@myagent/contracts";
import type { StoredHook } from "./hooks.js";
export interface PluginPackage {
  version: string;
  body: string;
  runtimePath: string;
  files: { path: string; hash: string; bytes: number; binary: boolean }[];
}
export interface PluginVersion {
  id: string;
  pluginId: string;
  package: PluginPackage;
  manifest: PluginManifest;
  source: PluginSource;
  commit: string | null;
}
export interface PluginBinding {
  id: string;
  pluginId: string;
  target: McpConfigTarget;
  revision: number;
  versionId: string;
  previousVersionId: string | null;
  previousSelection?: PluginSelection | null;
  /** 恢复继承保留修订号，防止删除再创建出现版本 ABA。 */
  inherit?: boolean;
  enabled: boolean;
  removed: boolean;
  selection: PluginSelection;
  configurationVersion: string;
  hooks: StoredHook[];
  credentialSlots: Record<
    string,
    { token: string | null; environment: Record<string, string> }
  >;
}
export interface PluginRun {
  id: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  references: PluginReference[];
  bindings: PluginBinding[];
}
export interface StoredPluginJob extends PluginJob {
  fingerprint: string;
  candidateId?: string;
  committedBindingId?: string;
  staged?: PluginBinding;
  newCredentialRefs?: string[];
}
export interface PluginRecords {
  credentials: { id: string };
  versions: PluginVersion;
  bindings: PluginBinding;
  runs: PluginRun;
  jobs: StoredPluginJob;
  operations: { id: string; fingerprint: string; value: unknown };
}
export interface PluginStore {
  get<K extends keyof PluginRecords>(
    kind: K,
    id: string,
  ): PluginRecords[K] | null;
  list<K extends keyof PluginRecords>(kind: K): PluginRecords[K][];
  put<K extends keyof PluginRecords>(kind: K, value: PluginRecords[K]): void;
  delete(kind: keyof PluginRecords, id: string): void;
  transaction<T>(fn: () => T): T;
}
