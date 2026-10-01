/** Skill 持久仓储：目录文件仍是真实来源；Run 保存目录/激活版本，包快照仅承担恢复与只读执行。 */
import type { ActiveSkill, SkillEntry, SkillSource } from "@myagent/contracts";
export interface StoredSkillPackage {
  id: string;
  version: string;
  body: string;
  runtimePath: string;
  files: { path: string; hash: string; bytes: number; binary: boolean }[];
}
export interface SkillRun {
  id: string;
  sessionId: string;
  questionId: string;
  entries: SkillEntry[];
  selected: string[];
  active: ActiveSkill[];
}
export interface SkillRecords {
  sources: SkillSource;
  enabled: { id: string; enabled: boolean };
  runs: SkillRun;
  packages: StoredSkillPackage;
}
export interface SkillStore {
  get<K extends keyof SkillRecords>(
    kind: K,
    id: string,
  ): SkillRecords[K] | null;
  list<K extends keyof SkillRecords>(kind: K): SkillRecords[K][];
  put<K extends keyof SkillRecords>(kind: K, value: SkillRecords[K]): void;
  delete(kind: keyof SkillRecords, id: string): void;
  transaction<T>(fn: () => T): T;
}
