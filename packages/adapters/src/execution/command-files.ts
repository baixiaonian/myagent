/** 命令规则文件适配：复用经验证的原子文件与路径边界，固定文件名不由 HTTP 或模型指定。 */
import { AppError, type CommandConfigTarget } from "@myagent/contracts";
import { containsPath } from "@myagent/kernel";
import type { CommandConfigFilePort, ExecutionStore } from "@myagent/state";
import { LocalMcpConfigFiles } from "../mcp/config-files.js";
import { canonicalPath, digest } from "./paths.js";
export class LocalCommandConfigFiles
  extends LocalMcpConfigFiles
  implements CommandConfigFilePort
{
  constructor(
    private readonly ruleDataDir: string,
    store: ExecutionStore,
  ) {
    super(ruleDataDir, store, "command-rules.json", "命令权限");
  }
  /** 用户文件的自动信任依赖数据根保护，不能用链接把可被模型改写的项目文件提升成用户规则。 */
  protected override async path(target: CommandConfigTarget): Promise<string> {
    const path = await super.path(target);
    if (
      target.scope === "user" &&
      !containsPath(
        await canonicalPath(this.ruleDataDir, "/"),
        await canonicalPath(path, "/"),
      )
    )
      throw new AppError(
        "protected_path",
        "用户命令规则不能通过符号链接指向数据目录之外。",
        403,
      );
    return path;
  }
  digest(text: string): string {
    return digest(text);
  }
}
