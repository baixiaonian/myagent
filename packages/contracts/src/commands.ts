/** 命令权限公开协议：规则、配置版本及审批依据；不表达沙箱资源授权，也不承载可执行回调。 */
export type CommandDecision = "allow" | "prompt" | "deny";
export interface CommandRule {
  id: string;
  pattern: string[];
  decision: CommandDecision;
  description?: string;
}
export interface CommandRuleDocument {
  schemaVersion: 1;
  rules: CommandRule[];
}
export interface CommandConfigTarget {
  scope: "user" | "project";
  workspaceId?: string;
}
export interface CommandConfigView {
  target: CommandConfigTarget;
  path: string;
  revision: string;
  text: string;
  document: CommandRuleDocument | null;
  lastValid: CommandRuleDocument | null;
  pending: boolean;
  error: string | null;
}
export interface CommandConfigSave extends CommandConfigTarget {
  expectedRevision: string;
  text: string;
}
export interface CommandConfigConfirmation extends CommandConfigTarget {
  expectedRevision: string;
}
export interface AnalyzedCommand {
  argv: string[];
  executable: string | null;
  /** 真实可执行文件身份参与审批绑定，防止同名程序继承低风险判断。 */
  executableIdentity: string | null;
  safe: boolean;
  reason: string;
}
export interface CommandAnalysis {
  commands: AnalyzedCommand[];
  opaque: boolean;
  reasons: string[];
}
export interface CommandRuleMatch extends CommandRule {
  scope: "user" | "project";
  commandIndex: number;
}
export interface CommandAssessment {
  command: string;
  cwd: string;
  decision: CommandDecision;
  reasons: string[];
  matches: CommandRuleMatch[];
  analysis: CommandAnalysis;
  policyRevision: string;
  /** 绑定调用、参数、目录身份、规则版本和可执行文件身份；不是可复用的授权。 */
  binding: string;
}
export interface CommandEvaluationInput {
  workspaceId: string;
  command: string;
  cwd?: string;
}
