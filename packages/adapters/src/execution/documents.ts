/** 本机文档适配器：限定登记项目内的 UTF-8 Markdown/HTML；拒绝符号链接，保存使用哈希复核及原子替换。
 * 与工具共享进程内锁，由 application 持有；外部编辑器不遵守此锁，最终复核缩小但不声称消除宿主文件系统竞态。
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import {
  AppError,
  DOCUMENT_MAX_BYTES,
  type DocumentDirectory,
  type DocumentSave,
  type ProjectDocument,
  type Workspace,
} from "@myagent/contracts";
import { containsPath } from "@myagent/kernel";
import type { DocumentFilePort } from "@myagent/state";
import { digest, type LocalWorkspace } from "./paths.js";

const supported = (path: string) => /\.(md|markdown|html|htm)$/i.test(path);
export class LocalDocumentFiles implements DocumentFilePort {
  constructor(private readonly workspaces: LocalWorkspace) {}
  private async target(
    workspace: Workspace,
    input: string,
    write = false,
  ): Promise<string> {
    await this.workspaces.validate(workspace);
    if (input.includes("\0"))
      throw new AppError("invalid_path", "文件路径无效。");
    const target = resolve(workspace.path, input);
    if (!containsPath(workspace.path, target))
      throw new AppError("document_outside", "只能打开当前项目内的文档。", 403);
    this.workspaces.assertAccessible(target, write);
    // 逐级拒绝链接，目录树不提供跟随链接入口；最终文件也用 O_NOFOLLOW 打开。
    let current = workspace.path;
    for (const part of relative(workspace.path, target)
      .split("/")
      .filter(Boolean)) {
      current = join(current, part);
      const info = await lstat(current).catch(() => null);
      if (!info)
        throw new AppError(
          "document_missing",
          "文件已移动或删除，请刷新目录。",
          404,
        );
      if (info.isSymbolicLink())
        throw new AppError(
          "document_symlink",
          "文档工作区不跟随符号链接。",
          403,
        );
    }
    return target;
  }
  async list(
    workspace: Workspace,
    input = ".",
    offset = 0,
  ): Promise<DocumentDirectory> {
    const target = await this.target(workspace, input);
    if (!(await lstat(target)).isDirectory())
      throw new AppError("invalid_directory", "目标不是目录。");
    const all = (await readdir(target, { withFileTypes: true }))
      .filter(
        (e) =>
          ![".git", "node_modules"].includes(e.name) &&
          !e.name.startsWith(".myagent-document-"),
      )
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      );
    return {
      path: relative(workspace.path, target) || ".",
      entries: all.slice(offset, offset + 300).map((e) => ({
        name: e.name,
        path: relative(workspace.path, join(target, e.name)),
        kind: e.isSymbolicLink()
          ? "symlink"
          : e.isDirectory()
            ? "directory"
            : e.isFile() && supported(e.name)
              ? "document"
              : "file",
      })),
      nextOffset: offset + 300 < all.length ? offset + 300 : null,
    };
  }
  private async load(path: string) {
    if (!supported(path))
      throw new AppError(
        "unsupported_document",
        "当前支持 .md、.markdown、.html 和 .htm 文档。",
      );
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile())
        throw new AppError("unsupported_document", "目标不是普通文件。");
      if (info.size > DOCUMENT_MAX_BYTES)
        throw new AppError(
          "document_too_large",
          "文档超过 1 MiB，请使用外部编辑器。",
          413,
        );
      const buffer = Buffer.alloc(DOCUMENT_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > DOCUMENT_MAX_BYTES)
        throw new AppError("document_too_large", "文档超过 1 MiB。", 413);
      let content: string;
      try {
        content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(buffer.subarray(0, bytesRead));
      } catch {
        throw new AppError("unsupported_document", "文档不是有效 UTF-8 文本。");
      }
      if (content.includes("\0"))
        throw new AppError("unsupported_document", "文档包含二进制数据。");
      const after = await handle.stat();
      if (info.mtimeMs !== after.mtimeMs || info.size !== after.size)
        throw new AppError(
          "file_conflict",
          "文件在读取时变化，请重新打开。",
          409,
        );
      return {
        content,
        revision: digest(content),
        bytes: bytesRead,
        mode: info.mode,
      };
    } finally {
      await handle.close();
    }
  }
  async read(workspace: Workspace, input: string): Promise<ProjectDocument> {
    const target = await this.target(workspace, input);
    const { content, revision, bytes } = await this.load(target);
    await this.target(workspace, input);
    return {
      path: relative(workspace.path, target),
      format: [".html", ".htm"].includes(extname(target).toLowerCase())
        ? "html"
        : "markdown",
      content,
      revision,
      bytes,
    };
  }
  async save(
    workspace: Workspace,
    input: DocumentSave,
  ): Promise<ProjectDocument> {
    if (
      Buffer.byteLength(input.content) > DOCUMENT_MAX_BYTES ||
      input.content.includes("\0")
    )
      throw new AppError(
        "document_too_large",
        "请保存不超过 1 MiB 的 UTF-8 文本。",
        413,
      );
    const target = await this.target(workspace, input.path, true);
    const before = await this.load(target);
    if (before.revision !== input.expectedRevision)
      throw new AppError(
        "file_conflict",
        "磁盘文档已有新版本。草稿已保留，请比较后重新保存。",
        409,
      );
    if (before.content === input.content)
      return this.read(workspace, input.path);
    const temporary = join(
      dirname(target),
      `.myagent-document-${randomUUID()}.tmp`,
    );
    try {
      const handle = await open(temporary, "wx", before.mode & 0o777);
      try {
        await handle.writeFile(input.content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.target(workspace, input.path, true);
      if ((await this.load(target)).revision !== input.expectedRevision)
        throw new AppError(
          "file_conflict",
          "文件在保存前变化，修改尚未提交。",
          409,
        );
      await rename(temporary, target);
      // 返回本次提交内容；不能把紧接着发生的外部写入冒充本次保存结果。
      return {
        path: relative(workspace.path, target),
        format: [".html", ".htm"].includes(extname(target).toLowerCase())
          ? "html"
          : "markdown",
        content: input.content,
        revision: digest(input.content),
        bytes: Buffer.byteLength(input.content),
      };
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
