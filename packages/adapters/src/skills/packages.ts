/** Skill 与 Hook 共用的本地包存储：拒绝链接/特殊文件，内容哈希发布，持久快照恢复只读副本。 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { AppError } from "@myagent/contracts";
import type { SkillPackage } from "@myagent/extensions";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) =>
  path === root || path.startsWith(`${root}${sep}`);
function fail(message: string): never {
  throw new AppError("invalid_package", message, 422);
}
export interface SkillFileLimits {
  fileBytes: number;
  packageBytes: number;
  files: number;
}
export class LocalPackageFiles {
  readonly runtimeRoot: string;
  protected readonly archive: string;
  constructor(
    private readonly dataDir: string,
    private readonly protectedPaths: string[] = [],
    protected readonly limits: SkillFileLimits = {
      fileBytes: 20 * 1024 ** 2,
      packageBytes: 100 * 1024 ** 2,
      files: 10000,
    },
    namespace = "skill",
  ) {
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        fail("包容量必须是正整数。");
    this.archive = join(dataDir, `${namespace}-packages`);
    this.runtimeRoot = join(
      realpathSync(tmpdir()),
      `myagent-${namespace}s-${hash(resolve(dataDir)).slice(0, 24)}`,
    );
    for (const path of [this.archive, this.runtimeRoot]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        fail("包存储目录不能是符号链接。");
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
  }
  validateSource(path: string): string {
    const actual = realpathSync(path);
    if (
      !lstatSync(actual).isDirectory() ||
      actual === sep ||
      this.protectedPaths.some(
        (root) => inside(root, actual) || inside(actual, root),
      ) ||
      inside(this.dataDir, actual) ||
      inside(actual, this.dataDir) ||
      inside(this.runtimeRoot, actual)
    )
      fail("请选择可访问的包目录，不能使用应用数据或运行目录。");
    return actual;
  }
  /** 同步清单用于 Run 建立前冻结版本；不跟随链接，并在有界读取前检查文件大小。 */
  inventory(path: string): SkillPackage["files"] {
    const root = this.validateSource(path),
      files: SkillPackage["files"] = [];
    let bytes = 0,
      visited = 0;
    const walk = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (item.name === ".git") continue;
        if (++visited > this.limits.files) fail("包文件数超过上限。");
        const p = join(dir, item.name),
          before = lstatSync(p);
        if (
          before.isSymbolicLink() ||
          (!before.isFile() && !before.isDirectory())
        )
          fail("包内不允许链接或特殊文件。");
        if (!inside(root, realpathSync(p))) fail("资源越出包目录。");
        if (before.isDirectory()) {
          walk(p);
          continue;
        }
        if (
          before.size > this.limits.fileBytes ||
          bytes + before.size > this.limits.packageBytes
        )
          fail("包容量超过上限。");
        const content = readFileSync(p),
          after = lstatSync(p);
        if (
          before.ino !== after.ino ||
          before.mtimeMs !== after.mtimeMs ||
          after.isSymbolicLink() ||
          content.length !== before.size
        )
          fail("包在读取期间变化。");
        bytes += content.length;
        let binary = content.includes(0);
        try {
          new TextDecoder("utf8", { fatal: true }).decode(content);
        } catch {
          binary = true;
        }
        files.push({
          path: relative(root, p),
          bytes: content.length,
          binary,
          hash: hash(content),
        });
      }
    };
    walk(root);
    return files;
  }
  async capturePackage(
    path: string,
    signal: AbortSignal,
    verify: () => void = () => {},
    bodyFile?: string,
  ): Promise<SkillPackage> {
    signal.throwIfAborted();
    verify();
    const root = this.validateSource(path);
    const staging = join(this.archive, `.staging-${randomUUID()}`);
    const files: SkillPackage["files"] = [];
    let bytes = 0,
      visited = 0;
    await mkdir(staging, { mode: 0o700 });
    try {
      const walk = async (directory: string) => {
        for (const item of (
          await readdir(directory, { withFileTypes: true })
        ).sort((a, b) => a.name.localeCompare(b.name))) {
          signal.throwIfAborted();
          if (item.name === ".git") continue;
          if (++visited > this.limits.files)
            fail("扩展包文件和目录数超过上限。");
          const path = join(directory, item.name),
            local = relative(root, path);
          // 不跟随任何包内链接，避免源文件被替换时读取包外；可添加真实目录作为独立来源。
          const before = await lstat(path);
          if (
            before.isSymbolicLink() ||
            (!before.isDirectory() && !before.isFile())
          )
            fail("扩展包包含链接或特殊文件，请改用包内普通文件。");
          if (before.isDirectory()) {
            await walk(path);
            continue;
          }
          if (
            before.size > this.limits.fileBytes ||
            bytes + before.size > this.limits.packageBytes ||
            files.length >= this.limits.files
          )
            fail("扩展包超过文件大小、总容量或文件数上限。");
          if (!inside(root, realpathSync(path))) fail("包资源越出包目录。");
          const buffer = await readFile(path);
          const after = await lstat(path);
          if (
            before.ino !== after.ino ||
            before.mtimeMs !== after.mtimeMs ||
            buffer.length !== before.size ||
            after.isSymbolicLink()
          )
            fail("扩展包在读取期间发生变化，请重新加载。");
          bytes += buffer.length;
          let binary = false;
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(buffer);
            binary = buffer.includes(0);
          } catch {
            binary = true;
          }
          files.push({
            path: local,
            bytes: buffer.length,
            binary,
            hash: hash(buffer),
          });
          await mkdir(dirname(join(staging, local)), { recursive: true });
          const saved = await open(join(staging, local), "wx", 0o600);
          try {
            await saved.writeFile(buffer);
            await saved.sync();
          } finally {
            await saved.close();
          }
        }
      };
      await walk(root);
      signal.throwIfAborted();
      verify();
      // 发布前复核所有内容，不能把读到一半时变化的多文件包混成一个版本。
      for (const file of files) {
        signal.throwIfAborted();
        const path = join(root, file.path);
        if (
          lstatSync(path).isSymbolicLink() ||
          !inside(root, realpathSync(path)) ||
          hash(await readFile(path)) !== file.hash
        )
          fail("包资源在快照期间变化，请重新加载。");
      }
      const inventory = this.inventory(root)
        .map((f) => f.path)
        .sort();
      if (
        JSON.stringify(inventory) !==
        JSON.stringify(files.map((f) => f.path).sort())
      )
        fail("扩展包目录在快照期间变化。");
      const version = hash(JSON.stringify(files));
      const target = join(this.archive, version);
      if (!existsSync(target)) await rename(staging, target);
      const directory = await open(this.archive, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const body = bodyFile
        ? new TextDecoder("utf-8", { fatal: true }).decode(
            await readFile(join(target, bodyFile)),
          )
        : "";
      const pkg = {
        version,
        body,
        files,
        runtimePath: join(this.runtimeRoot, version),
      };
      await this.materialize(pkg, signal);
      return pkg;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  /** 从持久内容恢复运行副本，路径由哈希决定；绝不从已经变化的源目录恢复。 */
  async materialize(pkg: SkillPackage, signal: AbortSignal): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/.test(pkg.version) ||
      pkg.runtimePath !== join(this.runtimeRoot, pkg.version)
    )
      fail("包快照身份无效。");
    const valid = () =>
      existsSync(pkg.runtimePath) &&
      !lstatSync(pkg.runtimePath).isSymbolicLink() &&
      (() => {
        const names: string[] = [];
        const visit = (dir: string): boolean =>
          readdirSync(dir, { withFileTypes: true }).every((e) => {
            const p = join(dir, e.name);
            if (e.isSymbolicLink()) return false;
            if (e.isDirectory()) return visit(p);
            if (!e.isFile()) return false;
            names.push(relative(pkg.runtimePath, p));
            return true;
          });
        return (
          visit(pkg.runtimePath) &&
          JSON.stringify(names.sort()) ===
            JSON.stringify(pkg.files.map((f) => f.path).sort())
        );
      })() &&
      pkg.files.every((f) => {
        const p = join(pkg.runtimePath, f.path);
        return (
          inside(pkg.runtimePath, resolve(p)) &&
          existsSync(p) &&
          !lstatSync(p).isSymbolicLink() &&
          inside(pkg.runtimePath, realpathSync(p)) &&
          hash(readFileSync(p)) === f.hash
        );
      });
    if (valid()) return;
    if (existsSync(pkg.runtimePath))
      fail("包运行副本已被修改，停止使用；请清理副本后恢复。");
    const staging = join(this.runtimeRoot, `.staging-${randomUUID()}`);
    try {
      await mkdir(staging, { mode: 0o700 });
      for (const file of pkg.files) {
        signal.throwIfAborted();
        if (!inside(staging, resolve(staging, file.path)))
          fail("包资源路径无效。");
        const content = await readFile(
          join(this.archive, pkg.version, file.path),
        );
        if (hash(content) !== file.hash) fail("包持久快照校验失败。");
        await mkdir(dirname(join(staging, file.path)), { recursive: true });
        await writeFile(join(staging, file.path), content, {
          mode: file.path.startsWith("scripts/") ? 0o500 : 0o400,
        });
      }
      await chmod(staging, 0o500);
      signal.throwIfAborted();
      try {
        await rename(staging, pkg.runtimePath);
      } catch (error) {
        if (!valid()) throw error;
      }
    } finally {
      await chmod(staging, 0o700).catch(() => {});
      await rm(staging, { recursive: true, force: true });
    }
  }
  collect(keep: Set<string>): void {
    for (const root of [this.archive, this.runtimeRoot])
      for (const name of readdirSync(root))
        if (
          (name.startsWith(".staging-") || /^[a-f0-9]{64}$/.test(name)) &&
          !keep.has(name)
        ) {
          try {
            const p = join(root, name);
            if (!lstatSync(p).isSymbolicLink()) {
              /* 仅回收本实例生成的目录。 */ chmodSync(p, 0o700);
              rmSync(p, { recursive: true, force: true });
            }
          } catch {
            /* 活动文件留待下一次维护。 */
          }
        }
  }
}
