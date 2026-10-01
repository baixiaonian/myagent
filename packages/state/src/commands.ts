/** 命令规则文件与确认记录：文件是事实源，数据库仅保存可信版本及原子落盘的恢复日志。 */
import type {
  CommandConfigTarget,
  CommandRuleDocument,
} from "@myagent/contracts";
export interface CommandConfigFilePort {
  read(
    target: CommandConfigTarget,
  ): Promise<{ path: string; text: string; revision: string }>;
  write(
    target: CommandConfigTarget,
    text: string,
    expectedRevision: string,
  ): Promise<string>;
  digest(text: string): string;
}
export interface CommandFileState {
  id: string;
  target: CommandConfigTarget;
  /** 用户确认的是语义版本；排版变化不新增授权。缺失文件的初始版本为空规则。 */
  trustedHash: string;
  document: CommandRuleDocument;
  staged?: { text: string; previousRevision: string };
}
