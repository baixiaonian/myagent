/** Hook 文件边界：配置 CAS、包内容版本、可信解释器和严格项目内资源；复用 Skill 包存储而不执行源目录文件。 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  AppError,
  type McpConfigTarget,
  type ResourceAccess,
  type Workspace,
} from "@myagent/contracts";
import {
  type FrozenHook,
  type HookFilesPort,
  type HookInspection,
  parseHookDocument,
} from "@myagent/extensions";
import { containsPath } from "@myagent/kernel";
import type { ExecutionStore } from "@myagent/state";
import { canonicalPath } from "../execution/paths.js";
import { LocalMcpConfigFiles } from "../mcp/config-files.js";
import { LocalPackageFiles } from "../skills/packages.js";

const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export class LocalHookFiles implements HookFilesPort {
  readonly packages: LocalPackageFiles;
  private readonly config: LocalMcpConfigFiles;
  constructor(
    private readonly dataDir: string,
    private readonly store: ExecutionStore,
    private readonly protectedPaths: string[] = [],
    private readonly userRoot = join(homedir(), "MyAgent/Hooks"),
  ) {
    this.packages = new LocalPackageFiles(
      dataDir,
      protectedPaths,
      undefined,
      "hook",
    );
    this.config = new LocalMcpConfigFiles(dataDir, store, "hooks.json", "Hook");
  }
  collect(keep: Set<string>): void {
    this.packages.collect(keep);
  }
  private path(target: McpConfigTarget): { path: string; root: string } {
    const workspace =
      target.scope === "project"
        ? this.store.get("workspaces", target.workspaceId ?? "")
        : null;
    if (target.scope === "project" && !workspace)
      throw new AppError("workspace_required", "请选择项目。");
    const root = workspace?.path ?? this.dataDir,
      path = join(
        root,
        ...(workspace ? [".myagent", "hooks.json"] : ["hooks.json"]),
      );
    // 文件不存在时同样检查最近存在祖先，拒绝 .myagent 链接向外和用户配置向项目降级。
    let parent = path;
    while (!existsSync(parent) && parent !== dirname(parent))
      parent = dirname(parent);
    if (!containsPath(realpathSync(root), realpathSync(parent)))
      throw new AppError("protected_path", "Hook 配置路径越界。", 403);
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new AppError("protected_path", "Hook 配置不能为符号链接。", 403);
    return { path, root };
  }
  private interpreter(name: FrozenHook["definition"]["interpreter"]): {
    path: string;
    identity: string;
  } {
    const candidates =
      name === "node"
        ? [process.execPath]
        : name === "sh"
          ? ["/bin/sh"]
          : [
              "/opt/homebrew/bin/python3",
              "/usr/bin/python3",
              "/usr/local/bin/python3",
            ];
    const found = candidates.find((p) => existsSync(p));
    if (!found)
      throw new AppError(
        "hook_interpreter",
        "找不到可信解释器，请安装配置中指定的解释器。",
      );
    const path = realpathSync(found),
      stat = statSync(path);
    if (!stat.isFile() || stat.mode & 0o002 || !(stat.mode & 0o111))
      throw new AppError("hook_interpreter", "解释器身份或权限无效。");
    return {
      path,
      identity: digest(
        JSON.stringify([
          path,
          stat.dev,
          stat.ino,
          stat.size,
          stat.mtimeMs,
          stat.mode,
        ]),
      ),
    };
  }
  read(target: McpConfigTarget) {
    const { path } = this.path(target);
    if (existsSync(path) && statSync(path).size > 262144)
      throw new AppError("config_limit", "Hook 配置超过 256 KiB。");
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    return { path, text, revision: digest(text) };
  }
  inspect(target: McpConfigTarget, text?: string): HookInspection {
    const { path, text: raw, revision } = this.read(target);
    const { root } = this.path(target);
    const document = parseHookDocument(text ?? raw);
    const hooks = this.freezeDefinitions(
      target,
      document,
      target.scope === "user" ? this.userRoot : root,
    );
    return {
      path,
      text: text ?? raw,
      revision,
      document,
      hooks,
      version: digest(JSON.stringify([document, hooks.map((h) => h.version)])),
    };
  }
  /** 插件仅从已经验证的运行副本捕获 Hook，不写用户 hooks.json。 */
  inspectPlugin(
    target: McpConfigTarget,
    document: import("@myagent/contracts").HookDocument,
    root: string,
  ): FrozenHook[] {
    return this.freezeDefinitions(target, document, root);
  }
  private freezeDefinitions(
    target: McpConfigTarget,
    document: import("@myagent/contracts").HookDocument,
    base: string,
  ): FrozenHook[] {
    const hooks = document.hooks
      .filter((h) => h.enabled)
      .map((definition) => {
        const packagePath = this.packages.validateSource(
          isAbsolute(definition.packagePath)
            ? definition.packagePath
            : resolve(base, definition.packagePath),
        );
        const files = this.packages.inventory(packagePath);
        if (!files.some((f) => f.path === definition.entry && !f.binary))
          throw new AppError("hook_entry", "Hook 入口不存在或不是文本文件。");
        const version = digest(JSON.stringify(files)),
          interpreter = this.interpreter(definition.interpreter);
        const frozen: FrozenHook = {
          id: `${target.scope}:${target.workspaceId ?? "global"}:${definition.id}`,
          scope: target.scope,
          definition: { ...definition, packagePath },
          version: "",
          package: {
            version,
            body: "",
            runtimePath: join(this.packages.runtimeRoot, version),
            files,
          },
          interpreterPath: interpreter.path,
          interpreterIdentity: interpreter.identity,
        };
        frozen.version = digest(JSON.stringify(frozen));
        return frozen;
      });
    return hooks;
  }
  async write(
    target: McpConfigTarget,
    text: string,
    expectedRevision: string,
  ): Promise<string> {
    this.path(target);
    return this.config.write(target, text, expectedRevision);
  }
  async capture(hooks: FrozenHook[], signal: AbortSignal): Promise<void> {
    for (const hook of hooks) {
      const pkg = await this.packages.capturePackage(
        hook.definition.packagePath,
        signal,
      );
      if (pkg.version !== hook.package.version)
        throw new AppError(
          "hook_changed",
          "脚本包已改变，请刷新预览后确认。",
          409,
        );
    }
  }
  async restore(
    hook: FrozenHook,
    workspace: Workspace,
    signal: AbortSignal,
  ): Promise<ResourceAccess[]> {
    await this.packages.materialize(hook.package, signal);
    await this.verify(hook, workspace);
    const resources: ResourceAccess[] = [
      { kind: "path", target: workspace.path, access: "read" },
      { kind: "path", target: hook.package.runtimePath, access: "read" },
    ];
    for (const path of hook.definition.permissions.writePaths) {
      const target = await canonicalPath(resolve(workspace.path, path), "/");
      if (
        !containsPath(workspace.path, target) ||
        this.protectedPaths
          .concat(this.dataDir, this.packages.runtimeRoot)
          .some((p) => containsPath(p, target) || containsPath(target, p))
      )
        throw new AppError(
          "protected_path",
          "Hook 写权限越出项目或触及受保护目录。",
          403,
        );
      resources.push({ kind: "path", target, access: "write" });
    }
    for (const domain of hook.definition.permissions.networkDomains)
      resources.push({ kind: "network", target: domain, access: "connect" });
    return resources;
  }
  async verify(hook: FrozenHook, workspace: Workspace): Promise<void> {
    const interpreter = this.interpreter(hook.definition.interpreter);
    if (
      interpreter.path !== hook.interpreterPath ||
      interpreter.identity !== hook.interpreterIdentity
    )
      throw new AppError(
        "hook_changed",
        "解释器版本已变化，请重新确认 Hook。",
        409,
      );
    const stat = statSync(realpathSync(workspace.path));
    // 与 LocalWorkspace 相同身份算法，目录替换不能继承授权。
    const identity = digest(
      `${realpathSync(workspace.path)}:${stat.dev}:${stat.ino}`,
    );
    if (identity !== workspace.identity)
      throw new AppError("workspace_changed", "项目目录身份已变化。", 409);
  }
}
