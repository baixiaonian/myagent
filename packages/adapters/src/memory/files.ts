/** 长期记忆 Markdown 适配器：限制路径、校验固定元数据、CAS 原子写入；多文件发布顺序由应用提交日志协调。 */
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { validateMemoryEntry } from "@myagent/content";
import { AppError, type MemoryEntry } from "@myagent/contracts";
import type { MemoryDocument, MemoryFiles } from "@myagent/state";

const HEADER = "# MyAgent 长期记忆\n\n<!-- myagent:format 1 -->\n";
export class LocalMemoryFiles implements MemoryFiles {
  readonly paths;
  private readonly root: string;
  constructor(
    dataDir: string,
    private readonly afterMainWrite?: () => void,
  ) {
    this.root = join(dataDir, "memories");
    this.paths = {
      memory: join(this.root, "MEMORY.md"),
      summary: join(this.root, "memory_summary.md"),
      rollouts: join(this.root, "rollout_summaries"),
    };
  }
  hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }
  private async safe(path: string, directory = false): Promise<void> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw new AppError("memory_io", "无法读取记忆文件。");
    });
    if (
      info &&
      (info.isSymbolicLink() ||
        (directory ? !info.isDirectory() : !info.isFile()))
    )
      throw new AppError("memory_path", "记忆文件不能是符号链接或特殊文件。");
  }
  private async ensure(): Promise<void> {
    await this.safe(this.root, true);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  async read(): Promise<MemoryDocument> {
    await this.safe(this.root, true);
    await this.safe(this.paths.memory);
    const info = await lstat(this.paths.memory).catch(() => null);
    if (info && info.size > 4 * 1024 * 1024)
      throw new AppError(
        "memory_limit",
        "记忆正文超过 4 MiB，请先整理或导出部分条目。",
      );
    const text = await readFile(this.paths.memory, "utf8").catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return "";
        throw new AppError("memory_io", "无法读取记忆正文。");
      },
    );
    // 已存在文件被截成零字节通常是编辑器写入中间态，不能当作“删除全部记忆”。
    if (info && !text)
      throw new AppError(
        "memory_format",
        "记忆文件为空或尚未写完，请恢复完整格式后同步。",
      );
    return { text, revision: this.hash(text), entries: this.parse(text) };
  }
  render(entries: MemoryEntry[]): string {
    return (
      HEADER +
      entries
        .map((entry) => {
          validateMemoryEntry(entry);
          const { text, ...meta } = entry;
          return `\n<!-- myagent:entry ${JSON.stringify(meta)} -->\n${text.trim()}\n<!-- myagent:end -->\n`;
        })
        .join("")
    );
  }
  parse(text: string): MemoryEntry[] {
    if (!text) return [];
    if (!text.startsWith(HEADER))
      throw new AppError(
        "memory_format",
        "记忆文件头无效，请保留格式标记并修改条目正文。",
      );
    const body = text.slice(HEADER.length);
    const pattern =
      /\n<!-- myagent:entry ([^\n]+) -->\n([\s\S]*?)\n<!-- myagent:end -->\n/g;
    const entries: MemoryEntry[] = [];
    const ids = new Set<string>();
    let last = 0;
    for (const match of body.matchAll(pattern)) {
      if (body.slice(last, match.index).trim())
        throw new AppError("memory_format", "条目外包含无法识别的内容。");
      let entry: MemoryEntry;
      try {
        entry = {
          ...JSON.parse(match[1] ?? ""),
          text: (match[2] ?? "").trim(),
        };
        validateMemoryEntry(entry);
      } catch {
        throw new AppError(
          "memory_format",
          `第 ${entries.length + 1} 条记忆的元数据或正文无效。`,
        );
      }
      if (ids.has(entry.id))
        throw new AppError("memory_format", "记忆 ID 重复。");
      ids.add(entry.id);
      entries.push(entry);
      last = (match.index ?? 0) + match[0].length;
    }
    if (body.slice(last).trim())
      throw new AppError(
        "memory_format",
        "记忆条目未完整结束，未覆盖上一有效版本。",
      );
    return entries;
  }
  private async atomic(
    path: string,
    text: string,
    expectedRevision?: string,
  ): Promise<void> {
    await this.safe(path);
    const temp = join(this.root, `.memory-${randomUUID()}.tmp`);
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(text, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await this.safe(path);
      if (
        expectedRevision !== undefined &&
        (await this.read()).revision !== expectedRevision
      )
        throw new AppError(
          "revision_conflict",
          "写入过程中记忆文件被外部修改，请刷新。",
          409,
        );
      await rename(temp, path);
      const dir = await open(this.root, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
  async write(text: string, expectedRevision: string): Promise<string> {
    this.parse(text);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024)
      throw new AppError("memory_limit", "记忆正文超过保存上限。");
    await this.ensure();
    if ((await this.read()).revision !== expectedRevision)
      throw new AppError(
        "revision_conflict",
        "记忆文件已被其他编辑器修改，请刷新。",
      );
    // 最后一次校验后仍不能锁住任意外部编辑器；与设置文件一致，CAS 不宣称跨进程强事务。
    if (text) await this.atomic(this.paths.memory, text, expectedRevision);
    else {
      // 仅用于撤销尚未启用的首次发布：恢复到原先不存在正文的状态，不能遗留非法空文件。
      await this.safe(this.paths.memory);
      await rm(this.paths.memory, { force: true });
      const directory = await open(this.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    this.afterMainWrite?.();
    return this.hash(text);
  }
  async derived(
    summary: string,
    rollout?: { id: string; text: string },
  ): Promise<void> {
    await this.ensure();
    await this.atomic(
      this.paths.summary,
      `# 长期记忆概览\n\n<!-- 自动生成；请在 MEMORY.md 或设置页面修改条目。 -->\n\n${summary}\n`,
    );
    if (rollout) {
      if (!/^[a-zA-Z0-9_-]{1,220}$/.test(rollout.id))
        throw new AppError("memory_path", "提炼记录 ID 无效。");
      await this.safe(this.paths.rollouts, true);
      await mkdir(this.paths.rollouts, { recursive: true, mode: 0o700 });
      await this.atomic(
        join(this.paths.rollouts, `${rollout.id}.md`),
        rollout.text,
      );
    }
  }
  async removeRollouts(sessionId: string): Promise<void> {
    await this.safe(this.paths.rollouts, true);
    for (const name of await readdir(this.paths.rollouts).catch(() => []))
      if (name.startsWith(`${sessionId}_`) && name.endsWith(".md")) {
        const path = join(this.paths.rollouts, name);
        await this.safe(path);
        await rm(path, { force: true });
      }
  }
}
