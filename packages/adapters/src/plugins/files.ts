/** 插件文件适配：不可变包捕获和公开 HTTPS Git 读取；安装阶段只读对象，不 checkout 或执行仓库代码。 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppError, type PluginSource } from "@myagent/contracts";
import {
  type PluginFilesPort,
  type PreparedPlugin,
  parsePluginManifest,
  pluginPath,
  type SkillPackage,
} from "@myagent/extensions";
import { LocalSkillFiles } from "../skills/files.js";
import { LocalPackageFiles } from "../skills/packages.js";

const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export class LocalPluginFiles implements PluginFilesPort {
  readonly packages: LocalPackageFiles;
  private readonly skills: LocalSkillFiles;
  constructor(dataDir: string, protectedPaths: string[] = []) {
    this.skills = new LocalSkillFiles(dataDir, protectedPaths);
    this.packages = new LocalPackageFiles(
      dataDir,
      protectedPaths,
      undefined,
      "plugin",
    );
  }
  async prepare(
    source: PluginSource,
    signal: AbortSignal,
  ): Promise<PreparedPlugin> {
    if (source.kind === "git")
      signal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    let path: string,
      commit: string | null = null,
      temporary: string | null = null;
    try {
      if (source.kind === "local") {
        path = this.packages.validateSource(source.path);
        source = { kind: "local", path };
      } else {
        let url: URL;
        try {
          url = new URL(source.url);
        } catch {
          throw new AppError(
            "invalid_plugin_source",
            "请输入公开 HTTPS Git 地址。",
          );
        }
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !url.hostname.includes(".") ||
          url.hostname === "localhost" ||
          /^(\d+\.)|[:[]/.test(url.hostname)
        )
          throw new AppError(
            "invalid_plugin_source",
            "仅支持不含凭证的公开 HTTPS Git 地址。",
          );
        if (
          source.ref &&
          (!/^[\w./-]{1,200}$/.test(source.ref) ||
            source.ref.startsWith("-") ||
            source.ref.includes(".."))
        )
          throw new AppError(
            "invalid_plugin_source",
            "Git 分支、标签或提交无效。",
          );
        temporary = await mkdtemp(join(tmpdir(), "myagent-plugin-fetch-"));
        const repo = join(temporary, "repo");
        await mkdir(repo);
        await this.git(repo, ["init", "--bare"], signal);
        await this.git(
          repo,
          [
            "fetch",
            "--depth=1",
            "--no-tags",
            "--no-recurse-submodules",
            url.href,
            source.ref ?? "HEAD",
          ],
          signal,
          200 * 1024 ** 2,
        );
        commit = (
          await this.git(repo, ["rev-parse", "FETCH_HEAD^{commit}"], signal)
        )
          .toString()
          .trim();
        const sub = source.subdirectory ? pluginPath(source.subdirectory) : "";
        const tree = (
          await this.git(
            repo,
            ["ls-tree", "-r", "-z", commit, ...(sub ? ["--", sub] : [])],
            signal,
          )
        )
          .toString("utf8")
          .split("\0")
          .filter(Boolean);
        const relativeNames = tree
          .map((line) => line.slice(line.indexOf("\t") + 1))
          .map((name) => (sub ? name.slice(sub.length + 1) : name));
        if (
          !relativeNames.includes("plugin.json") &&
          !relativeNames.includes(".codex-plugin/plugin.json")
        )
          throw new AppError(
            "invalid_plugin",
            "所选目录没有插件清单；仓库包含多个插件时请选择包子目录。",
          );
        if (tree.length > 10000)
          throw new AppError("package_limit", "Git 包文件数超过上限。");
        path = join(temporary, "package");
        await mkdir(path);
        let bytes = 0;
        for (const item of tree) {
          signal.throwIfAborted();
          const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(item);
          if (!match)
            throw new AppError("invalid_plugin_source", "Git 对象清单无效。");
          if (!["100644", "100755"].includes(match[1]!))
            throw new AppError(
              "invalid_plugin_source",
              "插件不能包含符号链接或子模块。",
            );
          const relative = sub ? match[4]!.slice(sub.length + 1) : match[4]!;
          pluginPath(relative);
          const content = await this.git(
            repo,
            ["cat-file", "blob", match[3]!],
            signal,
            20 * 1024 ** 2,
          );
          bytes += content.length;
          if (bytes > 100 * 1024 ** 2)
            throw new AppError("package_limit", "Git 包超过 100 MiB。");
          await mkdir(dirname(join(path, relative)), { recursive: true });
          await writeFile(join(path, relative), content, { mode: 0o600 });
        }
      }
      const pkg = await this.packages.capturePackage(path, signal);
      const docs = new Map<string, string>();
      for (const f of pkg.files)
        if (f.path.endsWith(".json")) {
          if (f.bytes > 262144) continue;
          docs.set(f.path, readFileSync(join(pkg.runtimePath, f.path), "utf8"));
        }
      const manifest = parsePluginManifest(
        docs,
        pkg.files.map((f) => f.path),
      );
      for (const c of manifest.components.filter((c) => c.kind === "skill")) {
        const entry = this.skills.scan({
          id: c.id,
          path: join(pkg.runtimePath, c.path!),
          scope: "user",
          workspaceId: null,
          enabled: true,
          builtin: false,
          revision: 0,
        })[0];
        if (!entry || entry.error)
          manifest.issues.push({
            id: c.id,
            componentId: c.id,
            blocking: true,
            message: entry?.error ?? "技能说明不可读取。",
          });
      }
      return { source, commit, package: pkg, manifest };
    } finally {
      this.skills.close();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
  /** Git 不继承宿主 HOME 配置、认证助手、环境脚本或工作区 PATH；错误响应不包含原始 stderr。 */
  private async git(
    cwd: string,
    args: string[],
    signal: AbortSignal,
    max = 4 * 1024 ** 2,
  ): Promise<Buffer> {
    const git = ["/usr/bin/git", "/opt/homebrew/bin/git"].find(
      (p) => existsSync(p) && lstatSync(realpathSync(p)).isFile(),
    );
    if (!git) throw new AppError("git_unavailable", "请安装 Git 后重试。");
    const local = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    local.throwIfAborted();
    return new Promise((resolveResult, reject) => {
      const child = spawn(
        git,
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "credential.helper=",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "-c",
          "http.followRedirects=false",
          ...args,
        ],
        {
          cwd,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: cwd,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_LFS_SKIP_SMUDGE: "1",
            LANG: "C",
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );
      const chunks: Buffer[] = [];
      let length = 0,
        failed = false;
      const stop = (message: string) => {
        failed = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        reject(new AppError("plugin_fetch_failed", message));
      };
      const cancel = () => stop("Git 获取已取消或超时。");
      local.addEventListener("abort", cancel, { once: true });
      child.stdout.on("data", (b: Buffer) => {
        length += b.length;
        if (length > max) stop("Git 输出超过容量上限。");
        else chunks.push(b);
      });
      child.stderr.resume();
      let checking = false;
      const interval = setInterval(() => {
        if (checking) return;
        checking = true;
        void directoryBytes(cwd)
          .then((n) => {
            if (n > 200 * 1024 ** 2) stop("Git 暂存超过 200 MiB。");
          })
          .catch(() => {})
          .finally(() => {
            checking = false;
          });
      }, 100);
      child.on("error", () => {
        clearInterval(interval);
        local.removeEventListener("abort", cancel);
        reject(new AppError("plugin_fetch_failed", "Git 无法启动。"));
      });
      child.on("close", (code) => {
        clearInterval(interval);
        local.removeEventListener("abort", cancel);
        if (failed) return;
        if (code === 0) resolveResult(Buffer.concat(chunks));
        else
          reject(
            new AppError(
              "plugin_fetch_failed",
              "Git 获取失败，请核对公开地址、版本和网络。",
            ),
          );
      });
    });
  }
  restore(pkg: SkillPackage, signal: AbortSignal) {
    return this.packages.materialize(pkg, signal);
  }
  verify(pkg: SkillPackage): void {
    const fail = () => {
      throw new AppError(
        "plugin_changed",
        "插件运行副本变化，请修复或重新安装。",
      );
    };
    if (
      !existsSync(pkg.runtimePath) ||
      lstatSync(pkg.runtimePath).isSymbolicLink() ||
      realpathSync(pkg.runtimePath) !== pkg.runtimePath
    )
      fail();
    const expected = new Map(pkg.files.map((f) => [f.path, f]));
    let count = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name),
          info = lstatSync(p);
        if (info.isSymbolicLink()) fail();
        if (info.isDirectory()) {
          walk(p);
          continue;
        }
        const relative = p.slice(pkg.runtimePath.length + 1),
          file = expected.get(relative);
        if (
          !info.isFile() ||
          !file ||
          info.size !== file.bytes ||
          digest(readFileSync(p)) !== file.hash
        )
          fail();
        count++;
      }
    };
    walk(pkg.runtimePath);
    if (count !== expected.size) fail();
  }
  collect(keep: Set<string>) {
    this.packages.collect(keep);
  }
}
async function directoryBytes(path: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    n += e.isDirectory() ? await directoryBytes(p) : (await stat(p)).size;
  }
  return n;
}
