/**
 * 本机路径与工作区校验：Server 在授权前解析真实目标，Worker 操作前再次核验。
 * 只允许真实目录工作区；标准模式的目标检查保护应用数据和运行程序，完全访问由注册表明确跳过目标权限。
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { AppError, type Workspace } from "@myagent/contracts";
import { containsPath, type WorkspacePort } from "@myagent/kernel";

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
/** 新文件向上找到存在的父目录再拼接尾部，避免尚未创建的路径跳过符号链接检查。 */
export async function canonicalPath(
  path: string,
  cwd: string,
): Promise<string> {
  if (!path || path.includes("\0"))
    throw new AppError("invalid_path", "文件路径无效。");
  const absolute = resolve(cwd, path);
  let parent = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(parent), ...suffix.reverse());
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw new AppError("invalid_path", "无法访问指定路径。");
      // 悬空符号链接不能当成普通的新建目标。
      try {
        if ((await lstat(parent)).isSymbolicLink())
          throw new AppError("invalid_path", "路径包含悬空符号链接。");
      } catch (cause) {
        if (cause instanceof AppError) throw cause;
      }
      const next = dirname(parent);
      if (next === parent)
        throw new AppError("invalid_path", "找不到路径父目录。");
      suffix.push(parent.slice(next.length).replace(/^\//, ""));
      parent = next;
    }
  }
}
export class LocalWorkspace implements WorkspacePort {
  constructor(
    readonly protectedPaths: readonly string[],
    readonly protectedWritePaths: readonly string[] = [],
  ) {}
  assertAccessible(path: string, write = false): void {
    if (
      write &&
      this.protectedWritePaths.some(
        (root) => containsPath(root, path) || containsPath(path, root),
      )
    )
      throw new AppError(
        "protected_path",
        "可信工具链目录不能作为工具写入目标。",
        403,
      );
    if (
      this.protectedPaths.some(
        (root) =>
          containsPath(root, path) || (write && containsPath(path, root)),
      )
    )
      throw new AppError(
        "protected_path",
        "MyAgent 的数据、凭证和运行程序不允许工具访问。",
        403,
      );
  }
  async create(path: string, name: string): Promise<Workspace> {
    if (!isAbsolute(path) || path === parse(path).root)
      throw new AppError(
        "invalid_workspace",
        "请选择具体的绝对目录，不能选择系统根目录。",
      );
    const canonical = await canonicalPath(path, "/");
    this.assertAccessible(canonical, true);
    const info = await stat(canonical).catch(() => null);
    if (!info?.isDirectory())
      throw new AppError("invalid_workspace", "工作区必须是已经存在的目录。");
    return {
      id: randomUUID(),
      name:
        name.trim().slice(0, 100) || canonical.split("/").at(-1) || "工作区",
      path: canonical,
      identity: digest(`${canonical}:${info.dev}:${info.ino}`),
      createdAt: new Date().toISOString(),
    };
  }
  async validate(workspace: Workspace): Promise<void> {
    this.assertAccessible(workspace.path, true);
    const canonical = await realpath(workspace.path).catch(() => null);
    const info = canonical ? await stat(canonical).catch(() => null) : null;
    if (
      !info?.isDirectory() ||
      digest(`${canonical}:${info.dev}:${info.ino}`) !== workspace.identity
    )
      throw new AppError(
        "workspace_changed",
        "工作区目录已移动或被替换，请重新绑定新会话。",
        409,
      );
  }
}
