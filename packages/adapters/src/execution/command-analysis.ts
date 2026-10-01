/**
 * Shell 命令分析适配器：WASM 语法树仅用于判断，不执行、不展开也不改写用户命令。
 * 仅静态 argv 与已知只读选项可自动放行；其余语法保留完整命令交给一次审批。
 */
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  type AnalyzedCommand,
  AppError,
  type CommandAnalysis,
} from "@myagent/contracts";
import { type CommandAnalyzerPort, containsPath } from "@myagent/kernel";
import { Language, type Node, Parser } from "web-tree-sitter";
import { executionSearchPath } from "./environment.js";

const require = createRequire(import.meta.url);
let language: Promise<Language> | undefined;
async function grammar(): Promise<Language> {
  language ??= (async () => {
    await Parser.init({
      locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm"),
    });
    return Language.load(
      require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),
    );
  })();
  try {
    return await language;
  } catch {
    throw new AppError(
      "command_parser_unavailable",
      "命令解析器不可用，已拒绝执行。",
      503,
    );
  }
}
/** 精确恢复静态字符串；变量、通配符、替换及 ANSI-C 字符串绝不靠猜测还原。 */
function token(node: Node): string | null {
  if (node.type === "command_name")
    return node.firstNamedChild ? token(node.firstNamedChild) : null;
  if (node.type === "raw_string") return node.text.slice(1, -1);
  if (node.type === "number") return node.text;
  if (node.type === "word") {
    if (/(^|[^\\])(?:\$|`|[*?[\]{}~])/.test(node.text)) return null;
    return node.text.replace(/\\\n/g, "").replace(/\\(.)/gs, "$1");
  }
  if (node.type === "string") {
    if (
      node.namedChildren
        .filter((child): child is Node => child !== null)
        .some((child) => child.type !== "string_content")
    )
      return null;
    return node.text
      .slice(1, -1)
      .replace(/\\\n/g, "")
      .replace(/\\([\\$`"])/g, "$1");
  }
  if (node.type === "concatenation") {
    const parts = node.namedChildren
      .filter((child): child is Node => child !== null)
      .map(token);
    return parts.some((part) => part === null) ? null : parts.join("");
  }
  return null;
}

// 参数白名单只声明本轮审查过的读取行为；未知选项即询问，不能仅凭程序名自动放行。
const options: Record<
  string,
  { flags: string; long: string[]; values: string[] }
> = {
  pwd: { flags: "LP", long: [], values: [] },
  ls: {
    flags: "aAlhdtFrRS1i",
    long: ["--all", "--almost-all", "--human-readable"],
    values: [],
  },
  cat: {
    flags: "benstuvET",
    long: ["--number", "--number-nonblank", "--squeeze-blank"],
    values: [],
  },
  head: { flags: "qv", long: [], values: ["-n", "-c", "--lines", "--bytes"] },
  tail: { flags: "qv", long: [], values: ["-n", "-c", "--lines", "--bytes"] },
  wc: {
    flags: "clmwL",
    long: ["--bytes", "--chars", "--lines", "--words"],
    values: [],
  },
  grep: {
    flags: "nirlwFxvEqscHoI",
    long: [
      "--line-number",
      "--ignore-case",
      "--fixed-strings",
      "--files-with-matches",
    ],
    values: ["-e", "-m", "-A", "-B", "-C"],
  },
  rg: {
    flags: "nilswFxqcoUI",
    long: [
      "--files",
      "--hidden",
      "--line-number",
      "--ignore-case",
      "--fixed-strings",
      "--no-ignore",
      "--no-config",
      "--count",
      "--files-with-matches",
    ],
    values: [
      "-e",
      "-m",
      "-A",
      "-B",
      "-C",
      "-g",
      "--glob",
      "--max-count",
      "--max-depth",
    ],
  },
};
function safeOptions(argv: string[], name: string): boolean {
  const allowed = options[name];
  if (!allowed) return false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") return true;
    if (arg === "-" || !arg.startsWith("-")) continue;
    if (allowed.long.includes(arg)) continue;
    if (allowed.values.includes(arg)) {
      if (++i >= argv.length) return false;
      continue;
    }
    if (
      /^-[^-]+$/.test(arg) &&
      [...arg.slice(1)].every((flag) => allowed.flags.includes(flag))
    )
      continue;
    return false;
  }
  return true;
}
async function executable(
  argv: string[],
  cwd: string,
): Promise<AnalyzedCommand> {
  const name = argv[0] ?? "";
  // pwd 由固定非登录 /bin/sh 内建执行；不继承外部 Shell 的 aliases/functions。
  if (name === "pwd")
    return {
      argv,
      executable: "/bin/sh:pwd",
      executableIdentity: "builtin-pwd-v1",
      safe: safeOptions(argv, "pwd"),
      reason: "固定 Shell 的目录查询；仅允许已审查选项。",
    };
  const candidates = name.includes("/")
    ? [isAbsolute(name) ? name : resolve(cwd, name)]
    : executionSearchPath()
        .split(":")
        .map((path) => join(path, name));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      const actual = await realpath(path);
      const info = await stat(actual);
      if (!info.isFile()) continue;
      const base = basename(actual);
      const trusted = [
        "/usr/bin",
        "/bin",
        "/opt/homebrew",
        "/usr/local/bin",
        "/usr/local/Cellar",
      ].some((root) => containsPath(root, actual));
      const safe =
        trusted && base === basename(name) && safeOptions(argv, base);
      return {
        argv,
        executable: actual,
        executableIdentity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`,
        safe,
        reason: safe
          ? "已核验来源及只读选项。"
          : "程序来源或参数不在低风险清单，需要批准。",
      };
    } catch {
      /* 按 Worker 的固定 PATH 继续查找；找不到的程序不能自动放行。 */
    }
  }
  return {
    argv,
    executable: null,
    executableIdentity: null,
    safe: false,
    reason: "无法核验可执行文件；需要批准。",
  };
}
export class ShellCommandAnalyzer implements CommandAnalyzerPort {
  async analyze(command: string, cwd: string): Promise<CommandAnalysis> {
    if (!command.trim() || command.length > 32000 || command.includes("\0"))
      throw new AppError(
        "invalid_command",
        "命令必须为 1–32,000 字符且不能包含 NUL。",
      );
    const loaded = await grammar();
    const parser = new Parser();
    const parsed: string[][] = [];
    const reasons = new Set<string>();
    let visited = 0;
    const opaque = () =>
      reasons.add(
        "包含动态展开、重定向、包装调用或复杂 Shell 语法，需批准完整命令。",
      );
    try {
      parser.setLanguage(loaded);
      const parse = (source: string, depth: number) => {
        const tree = parser.parse(source);
        if (!tree || tree.rootNode.hasError) {
          tree?.delete();
          throw new AppError(
            "invalid_command",
            "Shell 命令语法不完整或无法解析，未执行。",
          );
        }
        const visit = (node: Node, level: number) => {
          if (++visited > 8000 || level > 64) {
            opaque();
            return;
          }
          if (node.type === "comment") return;
          if (["program", "list", "pipeline"].includes(node.type)) {
            // 后台派发不能按普通管道判断，防止 shell 提前退出掩盖副作用。
            if (
              node.children.some(
                (child) =>
                  child !== null && ["&", "|&", "!"].includes(child.text),
              )
            )
              opaque();
            for (const child of node.namedChildren.filter(
              (child): child is Node => child !== null,
            ))
              visit(child, level + 1);
            return;
          }
          if (node.type === "command") {
            const argv: string[] = [];
            let complete = true;
            for (const child of node.namedChildren.filter(
              (child): child is Node => child !== null,
            )) {
              if (child.type === "variable_assignment") {
                opaque();
                continue;
              }
              const value = token(child);
              if (value === null) {
                opaque();
                complete = false;
              } else if (complete) argv.push(value);
            }
            if (argv.length) parsed.push(argv);
            const name = basename(argv[0] ?? "");
            if (
              [
                "sh",
                "bash",
                "zsh",
                "dash",
                "env",
                "command",
                "exec",
                "eval",
                "source",
                ".",
                "sudo",
                "xargs",
                "find",
              ].includes(name)
            ) {
              opaque();
              // 可识别的字面量 Shell 包装继续检查 deny，但包装本身仍需要完整审批。
              if (
                ["sh", "bash", "dash", "zsh"].includes(name) &&
                complete &&
                argv[1] === "-c" &&
                argv[2] &&
                depth < 3
              )
                parse(argv[2], depth + 1);
            }
            // 替换中的明确拒绝仍有意义；它绝不能让整个动态表达式获得 allow。
            const nested = (part: Node, level: number) => {
              if (level > 64) return;
              for (const child of part.namedChildren.filter(
                (child): child is Node => child !== null,
              )) {
                if (child.type === "command") visit(child, level + 1);
                else nested(child, level + 1);
              }
            };
            nested(node, level + 1);
            return;
          }
          opaque();
          for (const child of node.namedChildren.filter(
            (child): child is Node => child !== null,
          ))
            visit(child, level + 1);
        };
        try {
          visit(tree.rootNode, 0);
        } finally {
          tree.delete();
        }
      };
      parse(command, 0);
    } finally {
      parser.delete();
    }
    return {
      commands: await Promise.all(parsed.map((argv) => executable(argv, cwd))),
      opaque: reasons.size > 0,
      reasons: [...reasons],
    };
  }
}
