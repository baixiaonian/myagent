/**
 * MCP 配置文件适配：用户级和项目级 JSON 是唯一配置来源；哈希用于乐观并发与信任确认。
 * 同进程写入串行，临时文件 fsync 后原子替换；读取限制大小并拒绝链接到项目外部。
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError, type McpConfigTarget } from "@myagent/contracts";
import { containsPath } from "@myagent/kernel";
import type { ExecutionStore, McpConfigFilePort } from "@myagent/state";
import { canonicalPath, digest } from "../execution/paths.js";

export class LocalMcpConfigFiles implements McpConfigFilePort {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly dataDir: string,
    private readonly store: ExecutionStore,
    private readonly filename = "mcp.json",
    private readonly label = "MCP",
  ) {}
  protected async path(target: McpConfigTarget): Promise<string> {
    if (target.scope === "user") return join(this.dataDir, this.filename);
    const workspace = this.store.get("workspaces", target.workspaceId ?? "");
    if (!workspace)
      throw new AppError("workspace_required", "请先选择项目。", 400);
    const path = join(workspace.path, ".myagent", this.filename);
    if (!containsPath(workspace.path, await canonicalPath(path, "/")))
      throw new AppError(
        "protected_path",
        "项目配置不能通过符号链接指向项目外部。",
        403,
      );
    return path;
  }
  async read(target: McpConfigTarget) {
    const path = await this.path(target);
    let text = "";
    try {
      if ((await stat(path)).size > 262144)
        throw new AppError(
          "config_limit",
          `${this.label} 配置不能超过 256 KiB。`,
        );
      text = await readFile(path, "utf8");
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error instanceof AppError
          ? error
          : new AppError("config_read", `无法读取${this.label}配置文件。`);
    }
    return { path, text, revision: digest(text) };
  }
  write(
    target: McpConfigTarget,
    text: string,
    expectedRevision: string,
  ): Promise<string> {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        const before = await this.read(target);
        if (before.revision !== expectedRevision)
          throw new AppError(
            "revision_conflict",
            "配置文件已被其他编辑器修改，请刷新后重试。",
            409,
          );
        await mkdir(dirname(before.path), { recursive: true, mode: 0o700 });
        const temporary = join(
          dirname(before.path),
          `.config-${randomUUID()}.tmp`,
        );
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(text, "utf8");
            await file.sync();
          } finally {
            await file.close();
          }
          if ((await this.read(target)).revision !== expectedRevision)
            throw new AppError(
              "revision_conflict",
              "保存期间配置文件发生变化。",
              409,
            );
          await rename(temporary, before.path);
          const directory = await open(dirname(before.path), "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          await rm(temporary, { force: true });
        }
        return digest(text);
      });
    this.tail = operation;
    return operation;
  }
}
