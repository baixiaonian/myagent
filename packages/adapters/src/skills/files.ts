/**
 * 本地 Skill 文件适配器：发现、受限 YAML、内容寻址快照与沙箱只读投影。
 * 不执行技能代码；源目录、持久包和运行副本相互分离，越界链接/特殊文件一律拒绝。
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  type FSWatcher,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  watch,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  AppError,
  type SkillEntry,
  type SkillResourcePage,
  type SkillSource,
} from "@myagent/contracts";
import {
  type SkillFilesPort,
  type SkillPackage,
  validateSkillMetadata,
} from "@myagent/extensions";
import { parseDocument } from "yaml";
import { LocalPackageFiles } from "./packages.js";

const hash = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
const inside = (root: string, path: string) =>
  path === root || path.startsWith(`${root}${sep}`);
function fail(message: string): never {
  throw new AppError("invalid_skill", message, 422);
}
export interface SkillFileLimits {
  fileBytes: number;
  packageBytes: number;
  files: number;
}
export class LocalSkillFiles
  extends LocalPackageFiles
  implements SkillFilesPort
{
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly dirty = new Set<string>();
  private readonly cache = new Map<
    string,
    { stamp: string; root: string; at: number; entries: SkillEntry[] }
  >();
  constructor(
    dataDir: string,
    protectedPaths: string[] = [],
    limits?: SkillFileLimits,
  ) {
    super(dataDir, protectedPaths, limits);
  }
  private document(root: string, file = "SKILL.md"): string {
    const target = join(root, file);
    if (
      !inside(realpathSync(root), realpathSync(target)) ||
      !lstatSync(target).isFile()
    )
      fail("技能说明不能通过链接访问包外文件。");
    if (lstatSync(target).size > 65536)
      fail(`${file} 超过 64 KiB，请把参考资料拆到独立文件。`);
    const buffer = readFileSync(target);
    if (buffer.byteLength > 65536) fail("技能文件读取期间超过大小上限。");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  }
  private yaml(text: string): Record<string, unknown> {
    const document = parseDocument(text, { uniqueKeys: true, schema: "core" });
    if (document.errors.length || document.warnings.length)
      fail("技能 YAML 无效或包含不支持的类型。");
    const value = document.toJS({ maxAliasCount: 0 }) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("技能元信息必须为对象。");
    return value as Record<string, unknown>;
  }
  scan(source: SkillSource, fresh = true): SkillEntry[] {
    if (!existsSync(source.path)) return [];
    let roots: string[];
    const stamp = JSON.stringify(source);
    let sourceRoot = "";
    try {
      const root = this.validateSource(source.path);
      if (
        source.builtin &&
        source.scope === "project" &&
        !inside(realpathSync(dirname(dirname(source.path))), root)
      )
        fail("项目技能目录链接越出项目，请显式登记真实目录。");
      sourceRoot = root;
      const cached = this.cache.get(source.id);
      if (
        !fresh &&
        cached?.stamp === stamp &&
        cached.root === root &&
        !this.dirty.has(root) &&
        Date.now() - cached.at < 1000
      )
        return structuredClone(cached.entries);
      this.dirty.delete(root);
      roots = existsSync(join(root, "SKILL.md"))
        ? [root]
        : readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory() || e.isSymbolicLink())
            .map((e) => join(root, e.name))
            .filter((p) => existsSync(join(p, "SKILL.md")));
      // 文件通知立即失效 UI 的短缓存；强制扫描和一秒 TTL 兜底，不把监听可靠性当作 Run 版本依据。
      if (!this.watchers.has(root))
        try {
          const watcher = watch(
            root,
            { recursive: true, persistent: false },
            () => {
              this.dirty.add(root);
            },
          );
          watcher.on("error", () => {
            watcher.close();
            this.watchers.delete(root);
          });
          this.watchers.set(root, watcher);
        } catch {
          /* 无监听能力时继续依赖扫描。 */
        }
    } catch {
      return [
        {
          id: hash(`${source.id}:error`),
          sourceId: source.id,
          scope: source.scope,
          name: basename(source.path),
          description: "",
          path: source.path,
          version: "",
          enabled: false,
          implicit: false,
          error: "技能来源目录不可访问。",
        },
      ];
    }
    const entries = roots.sort().map((path) => {
      const entry: SkillEntry = {
        id: hash(`${source.id}:${relative(source.path, path)}`),
        sourceId: source.id,
        scope: source.scope,
        name: basename(path),
        description: "",
        path,
        version: "",
        enabled: source.enabled,
        implicit: true,
        error: null,
      };
      try {
        if (!inside(realpathSync(source.path), realpathSync(path)))
          fail("技能目录链接越出登记来源，请单独登记真实目录。");
        const rootPath = realpathSync(path);
        const identity = lstatSync(rootPath);
        entry.directoryIdentity = hash(
          `${rootPath}:${identity.dev}:${identity.ino}`,
        );
        entry.path = rootPath;
        const text = this.document(rootPath);
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
          text,
        );
        if (!match || !match[2]?.trim())
          fail("SKILL.md 需要 YAML 头和非空说明正文。");
        Object.assign(
          entry,
          validateSkillMetadata(this.yaml(match?.[1] ?? ""), basename(path)),
        );
        entry.version = hash(text);
        if (existsSync(join(path, "agents/openai.yaml"))) {
          const metadata = this.yaml(this.document(path, "agents/openai.yaml"));
          const policy = metadata.policy as Record<string, unknown> | undefined;
          const ui = metadata.interface as Record<string, unknown> | undefined;
          entry.implicit = policy?.allow_implicit_invocation !== false;
          if (typeof ui?.display_name === "string")
            entry.displayName = ui.display_name.slice(0, 200);
          if (metadata.dependencies)
            entry.dependencies = JSON.stringify(metadata.dependencies).slice(
              0,
              4000,
            );
          entry.version = hash(
            `${text}\n${this.document(path, "agents/openai.yaml")}`,
          );
        }
      } catch (error) {
        entry.error =
          error instanceof AppError
            ? error.message
            : "技能文件无法解析，请检查编码和 YAML 格式。";
      }
      return entry;
    });
    this.cache.set(source.id, {
      stamp,
      root: sourceRoot,
      at: Date.now(),
      entries: structuredClone(entries),
    });
    return entries;
  }
  detail(entry: SkillEntry): string {
    return this.document(entry.path);
  }
  resources(entry: SkillEntry): { path: string; bytes: number }[] {
    const root = realpathSync(entry.path),
      out: { path: string; bytes: number }[] = [];
    let visited = 0;
    const walk = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (item.name === ".git") continue;
        if (++visited > this.limits.files) fail("技能资源数超过上限。");
        const p = join(dir, item.name);
        if (item.isSymbolicLink()) fail("技能包资源不能是符号链接。");
        if (item.isDirectory()) walk(p);
        else if (item.isFile())
          out.push({ path: relative(root, p), bytes: lstatSync(p).size });
      }
    };
    walk(root);
    return out;
  }
  private verifyEntry(entry: SkillEntry): void {
    const actual = realpathSync(entry.path),
      info = lstatSync(actual);
    if (entry.directoryIdentity !== hash(`${actual}:${info.dev}:${info.ino}`))
      throw new AppError(
        "skill_changed",
        "技能目录被替换，请在下一轮重新加载。",
        409,
      );
    const text = this.document(entry.path);
    const metadata = existsSync(join(entry.path, "agents/openai.yaml"))
      ? `\n${this.document(entry.path, "agents/openai.yaml")}`
      : "";
    if (hash(text + metadata) !== entry.version)
      throw new AppError(
        "skill_changed",
        "技能说明已更新，请在下一轮任务加载新版本。",
        409,
      );
  }
  async capture(entry: SkillEntry, signal: AbortSignal): Promise<SkillPackage> {
    return this.capturePackage(
      entry.path,
      signal,
      () => this.verifyEntry(entry),
      "SKILL.md",
    );
  }
  read(pkg: SkillPackage, path: string, cursor?: string): SkillResourcePage {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) fail("技能资源游标无效。");
    if (!path) {
      const files: { path: string; bytes: number; binary: boolean }[] = [];
      for (const file of pkg.files.slice(offset, offset + 20)) {
        const next = {
          path: file.path,
          bytes: file.bytes,
          binary: file.binary,
        };
        if (JSON.stringify([...files, next]).length > 7000) break;
        files.push(next);
      }
      if (!files.length && offset < pkg.files.length)
        fail("资源路径过长，无法分页展示。");
      return {
        path,
        files,
        runtimePath: pkg.runtimePath,
        nextCursor:
          offset + files.length < pkg.files.length
            ? String(offset + files.length)
            : null,
      };
    }
    const file = pkg.files.find((f) => f.path === path);
    if (!file || !inside(pkg.runtimePath, resolve(pkg.runtimePath, path)))
      fail("资源不属于已加载技能包。");
    if (file.binary)
      return {
        path,
        binary: true,
        bytes: file.bytes,
        runtimePath: join(pkg.runtimePath, path),
        nextCursor: null,
      };
    const buffer = readFileSync(join(this.archive, pkg.version, path));
    if (hash(buffer) !== file.hash) fail("技能资源快照校验失败。");
    const text = buffer.toString("utf8");
    // JSON 转义也计入反馈预算；游标按原字符位置推进，不用截断后的字符串猜位置。
    let end = Math.min(text.length, offset + 6000);
    let page: SkillResourcePage;
    do {
      page = {
        path,
        text: text.slice(offset, end),
        runtimePath: join(pkg.runtimePath, path),
        nextCursor: end < text.length ? String(end) : null,
      };
      if (JSON.stringify(page).length <= 7500) return page;
      end = offset + Math.floor((end - offset) / 2);
    } while (end > offset);
    return fail("资源引用过长，无法生成有界分页。");
  }
  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.cache.clear();
    this.dirty.clear();
  }
}
