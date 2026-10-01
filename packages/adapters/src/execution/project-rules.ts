/**
 * 项目根规则读取器：只读取工作区内 AGENTS.md，限制 64 KiB，并核对打开后的文件身份。
 * 不向父目录搜索，不执行脚本；符号链接越界或读取失败不能静默忽略规则。
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { AppError } from "@myagent/contracts";
import type { ProjectRulesPort } from "@myagent/state";
export class LocalProjectRules implements ProjectRulesPort {
  read(root: string) {
    let descriptor: number | undefined;
    try {
      const base = realpathSync(root);
      const path = join(base, "AGENTS.md");
      let target: string;
      try {
        target = realpathSync(path);
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return null;
        throw e;
      }
      const rel = relative(base, target);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new AppError(
          "project_rules_path",
          "项目规则链接指向工作区外部，无法自动读取。",
        );
      descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.size > 65536)
        throw new AppError(
          "project_rules_size",
          "项目根 AGENTS.md 必须是最多 64 KiB 的普通文件。",
        );
      const buffer = Buffer.alloc(65537);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = readSync(
          descriptor,
          buffer,
          bytes,
          buffer.length - bytes,
          bytes,
        );
        if (!read) break;
        bytes += read;
      }
      const after = statSync(path);
      if (
        bytes > 65536 ||
        bytes !== before.size ||
        realpathSync(path) !== target ||
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new AppError(
          "project_rules_changed",
          "读取期间项目规则发生变化，请重试。",
        );
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytes),
      );
      return {
        text,
        path,
        bytes,
        hash: createHash("sha256").update(text).digest("hex"),
      };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(
        "project_rules_read",
        "无法读取项目根 AGENTS.md，请检查权限和 UTF-8 编码。",
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}
