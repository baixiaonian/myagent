/**
 * 本机项目目录适配器：创建隔离的默认目录、枚举目录以及唤起原生文件夹窗口。
 * 原生窗口只由用户管理 API 触发，不作为模型工具；脚本固定且不拼接用户命令。
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AppError,
  type DirectoryListing,
  type DirectorySelection,
  type Workspace,
} from "@myagent/contracts";
import type { ProjectDirectoryPort } from "@myagent/state";
import { canonicalPath, digest, type LocalWorkspace } from "./paths.js";

export class LocalProjectDirectories implements ProjectDirectoryPort {
  private choosing: Promise<DirectorySelection> | null = null;
  constructor(
    private readonly workspaces: LocalWorkspace,
    readonly root: string,
    private readonly nativePicker?: () => Promise<DirectorySelection>,
  ) {}
  async prepare(
    path: string | undefined,
    allocation: string,
    kind: "project" | "default" | "diagnostic",
  ): Promise<Workspace> {
    if (!path) {
      path = join(
        this.root,
        kind === "diagnostic" ? ".mcp-check" : digest(allocation),
      );
      this.workspaces.assertAccessible(await canonicalPath(path, "/"), true);
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    const workspace = await this.workspaces.create(
      path,
      kind === "default"
        ? "默认项目"
        : kind === "diagnostic"
          ? "MCP 连接检测"
          : "",
    );
    return { ...workspace, kind };
  }
  async browse(path = homedir()): Promise<DirectoryListing> {
    const canonical = await realpath(resolve(path)).catch(() => {
      throw new AppError("invalid_path", "目录不存在或不可访问。");
    });
    this.workspaces.assertAccessible(canonical);
    const entries = await readdir(canonical, { withFileTypes: true }).catch(
      () => {
        throw new AppError("invalid_path", "无法读取这个目录。");
      },
    );
    return {
      path: canonical,
      parent: dirname(canonical) === canonical ? null : dirname(canonical),
      directories: entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 1000),
    };
  }
  pick(): Promise<DirectorySelection> {
    if (this.choosing) return this.choosing;
    this.choosing = (this.nativePicker?.() ?? this.systemPicker()).finally(
      () => {
        this.choosing = null;
      },
    );
    return this.choosing;
  }
  private systemPicker(): Promise<DirectorySelection> {
    const unavailable: DirectorySelection = {
      status: "unavailable",
      message: "当前环境无法显示系统窗口，请在页面中浏览目录或输入路径。",
    };
    if (
      process.env.MYAGENT_CONTAINER === "1" ||
      (process.platform !== "darwin" &&
        (process.platform !== "linux" ||
          (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)))
    )
      return Promise.resolve(unavailable);
    return new Promise((resolveSelection) => {
      const mac = process.platform === "darwin";
      const child = spawn(
        mac ? "/usr/bin/osascript" : "zenity",
        mac
          ? [
              "-e",
              'tell application "Finder"\nactivate\nset chosenFolder to choose folder with prompt "选择 MyAgent 项目目录"\nreturn POSIX path of chosenFolder\nend tell',
            ]
          : [
              "--file-selection",
              "--directory",
              "--title=选择 MyAgent 项目目录",
            ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      let errors = "";
      const timer = setTimeout(() => {
        child.kill();
        resolveSelection(unavailable);
      }, 120000);
      child.stdout.on("data", (chunk) => {
        if (output.length < 16384) output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        if (errors.length < 4096) errors += String(chunk);
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolveSelection(unavailable);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && output.trim())
          resolveSelection({ status: "selected", path: output.trim() });
        else if ((!mac && code === 1) || errors.includes("(-128)"))
          resolveSelection({ status: "cancelled" });
        else resolveSelection(unavailable);
      });
    });
  }
}
