/** Skill 公开协议：目录元信息与 Run 激活投影；正文不是权限，文件路径仅指向登记来源或只读运行副本。 */
export interface SkillSource {
  plugin?: import("./plugins.js").PluginOrigin;
  id: string;
  path: string;
  scope: "user" | "project";
  workspaceId: string | null;
  enabled: boolean;
  builtin: boolean;
  revision: number;
}
export interface SkillEntry {
  plugin?: import("./plugins.js").PluginOrigin;
  id: string;
  sourceId: string;
  scope: SkillSource["scope"];
  name: string;
  description: string;
  path: string;
  version: string;
  /** 目录身份绑定本轮版本，拒绝加载期间的根目录替换。 */
  directoryIdentity?: string;
  enabled: boolean;
  implicit: boolean;
  displayName?: string;
  compatibility?: string;
  dependencies?: string;
  error: string | null;
}
export interface SkillCatalog {
  entries: SkillEntry[];
  sources: SkillSource[];
}
export interface ActiveSkill {
  plugin?: import("./plugins.js").PluginOrigin;
  id: string;
  name: string;
  sourceId: string;
  version: string;
  packageVersion: string;
  runtimePath: string;
  explicit: boolean;
}
export interface SkillContextView {
  active: ActiveSkill[];
  catalogTokens: number;
  instructionTokens: number;
  omitted: number;
}
export interface SkillPage {
  entries: SkillEntry[];
  nextCursor: string | null;
}
export interface SkillResourcePage {
  path: string;
  text?: string;
  files?: { path: string; bytes: number; binary: boolean }[];
  binary?: boolean;
  bytes?: number;
  runtimePath: string;
  nextCursor: string | null;
}
export interface SkillSourceInput {
  path: string;
  scope: SkillSource["scope"];
  workspaceId?: string;
}
