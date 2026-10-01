/**
 * 沙箱子进程中的文件工具实现：按最终权限检查路径，读取按页返回，修改校验原内容哈希。
 * 输入由 Worker 经 stdin 提供；这里不接触主数据库或凭证。临时文件与目标同目录原子替换。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AppError,
  type JsonValue,
  type ResourceAccess,
} from "@myagent/contracts";
import { containsPath } from "@myagent/kernel";
import { canonicalPath } from "./paths.js";

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest("hex");
}
async function checked(
  path: string,
  write: boolean,
  scopes: ResourceAccess[],
): Promise<string> {
  const canonical = await canonicalPath(path, "/");
  if (canonical !== path)
    throw new AppError(
      "execution_changed",
      "文件路径在执行前发生变化，请重新读取。",
      409,
    );
  if (
    !scopes.some(
      (scope) =>
        scope.kind === "path" &&
        containsPath(scope.target, canonical) &&
        (!write || scope.access === "write"),
    )
  )
    throw new AppError(
      "permission_denied",
      "文件目标不在本次授权范围内。",
      403,
    );
  return canonical;
}
function cursorOffset(value: JsonValue | undefined, version: string): number {
  if (value === undefined) return 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(String(value), "base64url").toString("utf8"),
    ) as { version: string; offset: number };
    if (parsed.version !== version)
      throw new AppError(
        "file_changed",
        "文件或查询已变化，请从第一页重新读取。",
        409,
      );
    if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0)
      throw new Error();
    return parsed.offset;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_cursor", "文件分页游标无效。");
  }
}
function nextCursor(version: string, offset: number): string {
  return Buffer.from(JSON.stringify({ version, offset })).toString("base64url");
}

export async function executeFileTool(
  name: string,
  args: Record<string, JsonValue>,
  scopes: ResourceAccess[],
): Promise<JsonValue> {
  const write = name === "write_file" || name === "edit_file";
  const path = await checked(String(args.path), write, scopes);
  if (name === "list_directory") {
    const entries = (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    const version = createHash("sha256")
      .update(JSON.stringify(entries.map((entry) => entry.name)))
      .digest("hex");
    const offset = cursorOffset(args.cursor, version);
    const limit = Math.min(Number(args.limit ?? 100), 500);
    return {
      path,
      entries: entries.slice(offset, offset + limit).map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : "file",
      })),
      cursor:
        offset + limit < entries.length
          ? nextCursor(version, offset + limit)
          : null,
      total: entries.length,
    };
  }
  if (name === "read_file") {
    const info = await stat(path);
    if (!info.isFile())
      throw new AppError("invalid_file", "目标不是普通文件。");
    const hash = await fileHash(path);
    const offset = cursorOffset(args.cursor, hash);
    if (offset > info.size)
      throw new AppError("invalid_cursor", "读取位置超出文件。");
    const handle = await open(path, "r");
    const buffer = Buffer.alloc(
      Math.min(32000, Math.max(4, Number(args.limit ?? 8000) * 4)),
    );
    let count: number;
    try {
      count = (await handle.read(buffer, 0, buffer.length, offset)).bytesRead;
    } finally {
      await handle.close();
    }
    // 页末最多回退三个字节以保留完整 UTF-8；拒绝二进制而不是给模型乱码。
    let text = "";
    let consumed = count;
    for (let trim = 0; trim <= 3; trim++) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, count - trim),
        );
        consumed = count - trim;
        break;
      } catch {
        if (trim === 3 || offset + count >= info.size)
          throw new AppError("unsupported_file", "文件不是有效 UTF-8 文本。");
      }
    }
    if (text.includes("\0"))
      throw new AppError(
        "unsupported_file",
        "当前文件工具只读取文字，不读取二进制内容。",
      );
    let visibleEnd = Math.min(Number(args.limit ?? 8000), 8000, text.length);
    if (
      visibleEnd < text.length &&
      text.charCodeAt(visibleEnd - 1) >= 0xd800 &&
      text.charCodeAt(visibleEnd - 1) <= 0xdbff
    )
      visibleEnd = visibleEnd === 1 ? 2 : visibleEnd - 1;
    const visible = text.slice(0, visibleEnd);
    consumed = Buffer.byteLength(visible);
    if ((await fileHash(path)) !== hash)
      throw new AppError("file_changed", "读取期间文件发生变化，请重试。", 409);
    return {
      path,
      text: visible,
      sha256: hash,
      startByte: offset,
      totalBytes: info.size,
      cursor:
        offset + consumed < info.size
          ? nextCursor(hash, offset + consumed)
          : null,
    };
  }
  if (name === "search_files") {
    const query = String(args.query);
    const mode = String(args.mode ?? "content");
    const version = createHash("sha256")
      .update(JSON.stringify([path, query, mode]))
      .digest("hex");
    const offset = cursorOffset(args.cursor, version);
    const limit = Math.min(Number(args.limit ?? 100), 500);
    const matches: JsonValue[] = [];
    let visited = 0;
    let skippedLarge = 0;
    let capped = false;
    const walk = async (directory: string): Promise<void> => {
      if (capped || matches.length > offset + limit) return;
      const entries = (await readdir(directory, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (++visited > 10000) {
          capped = true;
          return;
        }
        const target = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(target);
          continue;
        }
        if (!entry.isFile()) continue;
        await checked(target, false, scopes);
        if (mode === "path") {
          if (target.includes(query)) matches.push({ path: target });
        } else {
          const info = await stat(target);
          if (info.size > 1024 * 1024) {
            skippedLarge++;
            continue;
          }
          const text = await readFile(target, "utf8");
          if (text.includes("\0")) continue;
          const lines = text.split(/\r?\n/);
          for (let index = 0; index < lines.length; index++)
            if (lines[index]?.includes(query)) {
              matches.push({
                path: target,
                line: index + 1,
                text: lines[index]?.slice(0, 1000) ?? "",
              });
              if (matches.length > offset + limit) return;
            }
        }
        if (matches.length > offset + limit) return;
      }
    };
    await walk(path);
    return {
      matches: matches.slice(offset, offset + limit),
      cursor:
        matches.length > offset + limit
          ? nextCursor(version, offset + limit)
          : null,
      capped,
      skippedLargeFiles: skippedLarge,
      note: skippedLarge
        ? "部分超过 1 MiB 的文件未搜索正文，可通过 read_file 分页读取。"
        : "搜索只反映执行时目录状态。",
    };
  }
  if (!write) throw new AppError("unknown_tool", "文件工具不存在。");
  let info = await lstat(path).catch(() => null);
  if (info && !info.isFile())
    throw new AppError("invalid_file", "写入目标必须是普通文件。");
  const before = info ? await fileHash(path) : null;
  if (args.expectedHash !== before)
    throw new AppError(
      "file_conflict",
      "文件与读取时版本不同，请重新读取后再修改。",
      409,
    );
  let content = String(args.content ?? "");
  if (name === "edit_file") {
    if (!info || info.size > 20 * 1024 * 1024)
      throw new AppError(
        "invalid_file",
        "编辑需要存在且不超过 20 MiB 的文字文件。",
      );
    const old = await readFile(path, "utf8");
    const needle = String(args.oldText);
    const first = old.indexOf(needle);
    if (first < 0 || old.indexOf(needle, first + needle.length) >= 0)
      throw new AppError(
        "edit_conflict",
        "待替换文本必须在文件中唯一匹配。",
        409,
      );
    content =
      old.slice(0, first) +
      String(args.newText) +
      old.slice(first + needle.length);
  }
  const parent = await checked(dirname(path), true, scopes);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.myagent-${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      "wx",
      info ? info.mode & 0o777 : 0o600,
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checked(path, true, scopes);
    info = await lstat(path).catch(() => null);
    if ((info ? await fileHash(path) : null) !== before)
      throw new AppError(
        "file_conflict",
        "文件在写入前发生变化，修改未提交。",
        409,
      );
    await rename(temporary, path);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return {
      path,
      beforeHash: before,
      afterHash: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    };
  } finally {
    await rm(temporary, { force: true });
  }
}
