/**
 * 独立 Worker 监督器：在沙箱外持有代理和执行回执，按固定模式将真实文件/命令放到沙箱或完全访问子进程。
 * 每实例只接受一次权限配置；父进程断开立即终止子进程，不运行模型或修改主会话数据库。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AppError,
  EXECUTION_LIMITS,
  type ExecutionReceipt,
  type JsonValue,
  type ProcessSession,
  type WorkerCatalogEvent,
  type WorkerConfiguration,
  type WorkerExecution,
  type WorkerProcessEvent,
  type WorkerReply,
  type WorkerRequest,
} from "@myagent/contracts";
import { createToolPreview } from "@myagent/kernel";
import { SandboxStdioTransport } from "../mcp/stdio.js";
import { executionSearchPath } from "./environment.js";
import { processBirthTime, terminateProcessGroup } from "./process-groups.js";

interface RunningProcess {
  child: ChildProcess;
  execution: WorkerExecution;
  state: ProcessSession;
  path: string;
  stderr: string;
  bytes: number;
  output: Promise<void>;
  exited: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  stopReason: string | null;
  finalReceipt: ExecutionReceipt | null;
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
/** Worker 也不继承主服务的云密钥、代理和加载器环境；只保留运行工具链所需的基础项。 */
export function executionEnvironment(scratch: string): Record<string, string> {
  return {
    PATH: executionSearchPath(),
    HOME: scratch,
    TMPDIR: scratch,
    CLAUDE_CODE_TMPDIR: scratch,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "dumb",
  };
}
const journalWrites = new Map<string, Promise<void>>();
async function durableJson(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  const operation = (journalWrites.get(path) ?? Promise.resolve()).then(() =>
    writeJournal(path, text),
  );
  journalWrites.set(path, operation);
  try {
    await operation;
  } finally {
    if (journalWrites.get(path) === operation) journalWrites.delete(path);
  }
}
async function writeJournal(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function safe(error: unknown): { code: string; message: string } {
  return error instanceof AppError
    ? { code: error.code, message: error.message }
    : {
        code: "execution_failed",
        message: "本地执行失败，请检查沙箱依赖、路径及权限。",
      };
}
export class NativeWorkerRuntime {
  private configuration: WorkerConfiguration | null = null;
  private readonly processes = new Map<string, RunningProcess>();
  private readonly attempts = new Map<string, Promise<ExecutionReceipt>>();
  private closing = false;
  private mcp: Client | null = null;
  private mcpTransport: SandboxStdioTransport | null = null;
  private readonly mcpControllers = new Map<string, AbortController>();
  private mcpSecrets: string[] = [];
  constructor(
    private readonly notify: (
      event: WorkerProcessEvent | WorkerCatalogEvent,
    ) => void,
  ) {}
  async initialize(configuration: WorkerConfiguration): Promise<void> {
    if (this.configuration)
      throw new AppError(
        "worker_initialized",
        "Worker 权限配置不能在运行中替换。",
      );
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new AppError(
        "sandbox_unavailable",
        "本轮原生执行支持 macOS 和 Linux。",
        503,
      );
    await mkdir(configuration.recordDir, { recursive: true, mode: 0o700 });
    await mkdir(configuration.scratchDir, { recursive: true, mode: 0o700 });
    // 完全访问是显式执行分支，不探测隔离，也不能由探测失败自动进入。
    // 监督 Worker、intent/receipt、限时及进程组清理保持；不会提升为 root。
    if (configuration.executionMode === "full_access") {
      this.configuration = configuration;
      return;
    }
    const dependencies = await SandboxManager.checkDependenciesAsync();
    if (dependencies.errors.length)
      throw new AppError(
        "sandbox_unavailable",
        "缺少原生沙箱依赖，请检查 sandbox-exec 或 bubblewrap、socat、ripgrep。",
        503,
      );
    const readable = configuration.resources
      .filter((resource) => resource.kind === "path")
      .map((resource) => resource.target);
    const writable = configuration.resources
      .filter(
        (resource) => resource.kind === "path" && resource.access === "write",
      )
      .map((resource) => resource.target);
    const nodeRoot = dirname(dirname(await realpath(process.execPath)));
    const system = [
      "/System",
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/dev",
      "/Library/Apple",
      "/opt/homebrew",
      "/private/etc/ssl",
      "/etc/ssl",
      "/private/var/db/timezone",
      "/private/var/select",
      nodeRoot,
      configuration.runtimeRoot,
    ].filter((path) => existsSync(path));
    const deniedAddresses = Object.values(networkInterfaces()).flatMap(
      (entries) => entries?.map((entry) => entry.address) ?? [],
    );
    const config: SandboxRuntimeConfig = {
      filesystem: {
        denyRead: ["/", ...configuration.protectedPaths],
        allowRead: [...system, configuration.scratchDir, ...readable],
        allowWrite: [configuration.scratchDir, ...writable],
        denyWrite: [
          configuration.runtimeRoot,
          ...(configuration.readOnlyPaths ?? []),
          nodeRoot,
          "/opt/homebrew",
          "/usr",
          "/bin",
          "/sbin",
          "/lib",
          "/lib64",
          "/System",
          "/tmp/claude",
          "/private/tmp/claude",
          ...configuration.protectedPaths,
        ],
      },
      network: {
        allowedDomains: configuration.resources
          .filter((resource) => resource.kind === "network")
          .map((resource) => resource.target),
        deniedDomains: [
          "localhost",
          "*.localhost",
          "127.0.0.1",
          "::1",
          ...deniedAddresses,
        ],
        deniedResolvedAddresses: [
          "127.0.0.0/8",
          "::1/128",
          "169.254.0.0/16",
          ...(configuration.origin === "hook"
            ? [
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "100.64.0.0/10",
                "fc00::/7",
                "fe80::/10",
              ]
            : []),
        ],
        strictAllowlist: true,
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      },
      enableWeakerNestedSandbox: false,
      allowAppleEvents: false,
    };
    await SandboxManager.initialize(config, undefined, false);
    // 功能探测而非仅检查二进制存在；无效内核/容器配置不得降级成裸进程。
    const command = await SandboxManager.wrapWithSandboxArgv(
      "printf myagent-sandbox-ready",
      "/bin/sh",
      undefined,
      undefined,
      configuration.scratchDir,
      { commandId: randomUUID() },
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.argv[0] ?? "", command.argv.slice(1), {
        cwd: configuration.scratchDir,
        env: {
          ...executionEnvironment(configuration.scratchDir),
          ...command.env,
        },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new AppError("sandbox_unavailable", "沙箱探测超时。", 503));
      }, 5000);
      child.on("error", () => {
        clearTimeout(timer);
        reject(new AppError("sandbox_unavailable", "无法启动原生沙箱。", 503));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 && output === "myagent-sandbox-ready"
          ? resolve()
          : reject(
              new AppError(
                "sandbox_unavailable",
                "原生沙箱功能探测失败。",
                503,
              ),
            );
      });
    });
    this.configuration = configuration;
  }
  private config(): WorkerConfiguration {
    if (!this.configuration || this.closing)
      throw new AppError("worker_unavailable", "执行 Worker 不可用。", 503);
    return this.configuration;
  }
  execute(execution: WorkerExecution): Promise<ExecutionReceipt> {
    const existing = this.attempts.get(execution.attemptId);
    if (existing) return existing;
    const operation = this.executeOnce(execution);
    this.attempts.set(execution.attemptId, operation);
    return operation;
  }
  private async executeOnce(
    execution: WorkerExecution,
  ): Promise<ExecutionReceipt> {
    const config = this.config();
    const receiptPath = join(
      config.recordDir,
      `${execution.attemptId}.receipt.json`,
    );
    if (existsSync(receiptPath))
      return JSON.parse(
        await readFile(receiptPath, "utf8"),
      ) as ExecutionReceipt;
    await durableJson(
      join(config.recordDir, `${execution.attemptId}.intent.json`),
      { execution, acceptedAt: new Date().toISOString() },
    );
    let receipt: ExecutionReceipt;
    try {
      if (
        ["read_process", "write_stdin", "stop_process"].includes(execution.name)
      ) {
        const data = await this.control(execution);
        receipt = this.receipt(
          execution,
          "succeeded",
          data,
          null,
          execution.name === "write_stdin",
        );
      } else {
        const hook = execution.hook;
        const fileAction = !hook && execution.name !== "exec_command";
        const hookChunks: Buffer[] = [];
        let hookBytes = 0;
        const command = hook
          ? `${shellQuote(process.execPath)} ${shellQuote(join(dirname(config.actionPath), "hook.js"))}`
          : fileAction
            ? `${shellQuote(process.execPath)} ${shellQuote(config.actionPath)}`
            : String(execution.arguments.command);
        const cwd =
          fileAction || hook
            ? config.workspace.path
            : String(execution.arguments.cwd ?? config.workspace.path);
        const wrapped =
          config.executionMode === "full_access"
            ? { argv: ["/bin/sh", "-c", command], env: {} }
            : await SandboxManager.wrapWithSandboxArgv(
                command,
                "/bin/sh",
                undefined,
                undefined,
                cwd,
                { commandId: execution.attemptId, commandText: execution.name },
              );
        const child = spawn(wrapped.argv[0] ?? "", wrapped.argv.slice(1), {
          cwd,
          env: {
            ...executionEnvironment(config.scratchDir),
            ...(config.executionMode === "full_access" && config.userHome
              ? { HOME: config.userHome }
              : {}),
            ...wrapped.env,
          },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
        const processId = randomUUID();
        const path = join(config.recordDir, `${processId}.output.txt`);
        const state: ProcessSession = {
          id: processId,
          sessionId: execution.sessionId,
          runId: execution.runId,
          invocationId: execution.invocationId,
          workerId: config.workerId,
          pid: child.pid ?? 0,
          status: "running",
          exitCode: null,
          signal: null,
          outputRef: "",
          createdAt: new Date().toISOString(),
          endedAt: null,
        };
        let exit!: () => void;
        const exited = new Promise<void>((resolve) => {
          exit = resolve;
        });
        const item: RunningProcess = {
          child,
          execution,
          state,
          path,
          stderr: "",
          bytes: 0,
          output: Promise.resolve(),
          exited,
          timer: setTimeout(() => {}, 0),
          stopReason: null,
          finalReceipt: null,
        };
        clearTimeout(item.timer);
        this.processes.set(processId, item);
        const capture = (chunk: Buffer, stderr: boolean) => {
          if (hook && !stderr) {
            hookBytes += chunk.length;
            if (hookBytes <= 65536) hookChunks.push(chunk);
            else void this.stop(item, "hook_output_limit");
          }

          if (fileAction && stderr) {
            item.stderr = (item.stderr + chunk.toString("utf8")).slice(-4000);
            return;
          }
          const remaining = Math.max(
            0,
            EXECUTION_LIMITS.resultBytes - item.bytes,
          );
          const saved = chunk.subarray(0, remaining);
          item.bytes += saved.length;
          if (stderr)
            item.stderr = (item.stderr + saved.toString("utf8")).slice(-4000);
          item.output = item.output
            .then(() => appendFile(path, saved, { mode: 0o600 }))
            .catch(() => {
              state.outputComplete = false;
              void this.stop(item, "storage_failed");
            });
          if (saved.length < chunk.length) {
            state.outputComplete = false;
            void this.stop(item, "output_limit");
          }
        };
        child.stdout?.on("data", (chunk: Buffer) => capture(chunk, false));
        child.stderr?.on("data", (chunk: Buffer) => capture(chunk, true));
        child.stdin?.on("error", () => {
          /* 提前关闭 stdin 是进程状态，不允许 EPIPE 成为未处理异常。 */
        });
        child.once("error", () => {
          item.stopReason = "spawn_failed";
        });
        const processStarted = performance.now();
        child.once("close", (code, signal) => {
          clearTimeout(item.timer);
          void (async () => {
            const confirmed = child.pid
              ? await terminateProcessGroup(child.pid, 200)
              : true;
            state.exitCode = code;
            state.signal = signal;
            state.status = confirmed
              ? item.stopReason
                ? "stopped"
                : "exited"
              : "unknown";
            state.endedAt = new Date().toISOString();
            state.durationMs = performance.now() - processStarted;
            await item.output;
            const output = await open(path, "a", 0o600);
            try {
              await output.sync();
            } finally {
              await output.close();
            }
            await durableJson(
              join(config.recordDir, `${processId}.process.json`),
              state,
            );
            this.notify({ type: "process", process: state, outputPath: path });
          })()
            .catch(() => {
              state.status = "unknown";
              this.notify({
                type: "process",
                process: state,
                outputPath: path,
              });
            })
            .finally(exit);
        });
        item.timer = setTimeout(() => {
          void this.stop(item, "timeout");
        }, execution.timeoutMs);
        this.notify({
          type: "process",
          process: { ...state },
          outputPath: path,
        });
        const birth = child.pid ? await processBirthTime(child.pid) : null;
        if (birth) state.birthTime = birth;
        await durableJson(
          join(config.recordDir, `${processId}.process.json`),
          state,
        );
        if (hook) child.stdin?.end(JSON.stringify(hook));
        if (fileAction)
          child.stdin?.end(
            JSON.stringify({
              name: execution.name,
              arguments: execution.arguments,
              resources: execution.resources,
            }),
          );
        if (hook) {
          await exited;
          const failed = item.stopReason !== null || state.exitCode !== 0;
          receipt = this.receipt(
            execution,
            state.status === "unknown"
              ? "unknown"
              : failed
                ? "failed"
                : "succeeded",
            {
              stdout: Buffer.concat(hookChunks).toString("utf8"),
              stdoutBytes: hookBytes,
              processId,
              exitCode: state.exitCode,
              status: state.status,
            },
            failed
              ? {
                  code: item.stopReason ?? "hook_exit",
                  message: `Hook 执行失败（${item.stopReason ?? state.exitCode}）。`,
                }
              : null,
            execution.resources.some(
              (r) =>
                r.kind === "network" ||
                (r.kind === "path" && r.access === "write"),
            ),
          );
        } else if (fileAction) {
          await exited;
          if (item.state.status === "unknown")
            throw new AppError(
              "worker_protocol",
              "无法确认文件执行状态，需要核对结果。",
            );
          if (item.stopReason)
            throw new AppError(
              item.stopReason,
              item.stopReason === "timeout"
                ? "文件执行超时，可能已产生部分修改。"
                : "文件执行已停止或失败，需检查实际状态。",
            );
          let result: {
            ok: boolean;
            data: JsonValue;
            error: { code: string; message: string };
          };
          try {
            result = JSON.parse(await readFile(path, "utf8")) as typeof result;
          } catch {
            throw new AppError(
              "worker_protocol",
              "文件执行没有返回完整结果，需核对状态。",
            );
          }
          receipt = this.receipt(
            execution,
            result.ok ? "succeeded" : "failed",
            result.data ?? null,
            result.ok ? null : result.error,
            execution.name === "write_file" || execution.name === "edit_file",
          );
        } else {
          await Promise.race([
            exited,
            delay(Number(execution.arguments.yieldTimeMs ?? 1000)),
          ]);
          const failed =
            item.state.status !== "running" &&
            (item.state.exitCode !== 0 || item.stopReason !== null);
          receipt = this.receipt(
            execution,
            item.state.status === "unknown"
              ? "unknown"
              : failed
                ? "failed"
                : "succeeded",
            await this.processData(item),
            failed
              ? {
                  code: item.stopReason ?? "command_exit",
                  message: item.stopReason
                    ? "命令已停止或超时，可能已产生部分修改。"
                    : `命令退出码为 ${item.state.exitCode}。`,
                }
              : null,
            true,
          );
        }
      }
    } catch (error) {
      const uncertain =
        Boolean(execution.hook) ||
        execution.name === "write_file" ||
        execution.name === "edit_file" ||
        execution.name === "exec_command";
      const failure = safe(error);
      receipt = this.receipt(
        execution,
        failure.code === "worker_protocol" ? "unknown" : "failed",
        null,
        failure,
        uncertain,
      );
    }
    await durableJson(receiptPath, receipt);
    return receipt;
  }
  private receipt(
    execution: WorkerExecution,
    outcome: ExecutionReceipt["outcome"],
    data: JsonValue,
    error: ExecutionReceipt["error"],
    effectsPossible: boolean,
  ): ExecutionReceipt {
    return {
      attemptId: execution.attemptId,
      invocationId: execution.invocationId,
      outcome,
      data,
      error,
      effectsPossible,
      completedAt: new Date().toISOString(),
    };
  }
  private async processData(
    item: RunningProcess,
    page?: string,
  ): Promise<JsonValue> {
    await item.output;
    // 命令快照从已采集文件取真实头尾；分页读取仍按游标返回原文，不对页面再取头尾。
    const preview =
      page === undefined
        ? createToolPreview(
            await readFile(item.path, "utf8").catch(() => {
              if (item.bytes === 0) return "";
              throw new AppError(
                "result_missing",
                "已采集的进程输出文件不可用。",
              );
            }),
            6000,
            { reference: `read_process processId=${item.state.id} cursor=0` },
          )
        : { content: page, truncated: false };
    return {
      processId: item.state.id,
      status: item.state.status,
      output: preview.content,
      outputTruncated: preview.truncated,
      cursor: String(item.bytes),
      exitCode: item.state.exitCode,
      signal: item.state.signal,
      stopReason: item.stopReason,
      outputComplete: item.state.outputComplete !== false,
    };
  }
  private async control(execution: WorkerExecution): Promise<JsonValue> {
    const item = this.processes.get(String(execution.arguments.processId));
    if (
      !item ||
      item.state.runId !== execution.runId ||
      item.state.sessionId !== execution.sessionId
    )
      throw new AppError(
        "process_not_found",
        "进程不属于当前 Run 或已经不可用。",
        404,
      );
    if (execution.name === "write_stdin") {
      if (item.state.status !== "running")
        throw new AppError("process_exited", "进程已经退出。", 409);
      await new Promise<void>((resolve, reject) =>
        item.child.stdin?.write(String(execution.arguments.input), (error) =>
          error
            ? reject(new AppError("stdin_closed", "进程标准输入已经关闭。"))
            : resolve(),
        ),
      );
      if (execution.arguments.close === true) item.child.stdin?.end();
    } else if (execution.name === "stop_process")
      await this.stop(item, "user_stopped");
    else if (item.state.status === "running")
      await Promise.race([
        item.exited,
        delay(Number(execution.arguments.waitMs ?? 0)),
      ]);
    await item.output;
    const offset = Number(execution.arguments.cursor ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.bytes)
      throw new AppError("invalid_cursor", "进程输出游标无效。");
    const handle = await open(item.path, "r").catch(() => null);
    let output = "";
    let end = offset;
    if (handle)
      try {
        const buffer = Buffer.alloc(8000);
        const read = await handle.read(buffer, 0, buffer.length, offset);
        let count = read.bytesRead;
        // 字节游标不切开 UTF-8；正在写入的尾部不完整字符留给下一页。
        for (let trim = 0; trim <= 3 && trim <= read.bytesRead; trim++)
          try {
            output = new TextDecoder("utf-8", { fatal: true }).decode(
              buffer.subarray(0, read.bytesRead - trim),
            );
            count = read.bytesRead - trim;
            break;
          } catch {
            if (trim === 3) {
              output = buffer.subarray(0, read.bytesRead).toString("utf8");
              count = read.bytesRead;
            }
          }
        end += count;
      } finally {
        await handle.close();
      }
    return {
      ...((await this.processData(item, output)) as Record<string, JsonValue>),
      output,
      cursor: String(end),
      hasMore: end < item.bytes,
    };
  }
  async cancel(attemptId: string): Promise<void> {
    this.mcpControllers.get(attemptId)?.abort();
    for (const item of this.processes.values())
      if (item.execution.attemptId === attemptId)
        await this.stop(item, "cancelled");
  }
  private async stop(item: RunningProcess, reason: string): Promise<void> {
    if (item.state.status !== "running") return;
    item.stopReason ??= reason;
    const pid = item.child.pid;
    if (!pid) return;
    const confirmed = await terminateProcessGroup(
      pid,
      EXECUTION_LIMITS.terminationGraceMs,
    );
    await Promise.race([item.exited, delay(2000)]);
    if (!confirmed || item.state.status === "running") {
      item.state.status = "unknown";
      this.notify({
        type: "process",
        process: item.state,
        outputPath: item.path,
      });
    }
  }
  async close(): Promise<boolean> {
    this.closing = true;
    await Promise.all(
      [...this.processes.values()].map((item) => this.stop(item, "run_ended")),
    );
    let mcpConfirmed = true;
    try {
      await this.mcp?.close();
      await this.mcpTransport?.close();
    } catch {
      mcpConfirmed = false;
    }
    await SandboxManager.reset();
    return (
      mcpConfirmed &&
      [...this.processes.values()].every(
        (item) =>
          item.state.status !== "running" && item.state.status !== "unknown",
      )
    );
  }
  async connectMcp(
    command: string,
    args: string[],
    environment: Record<string, string>,
  ): Promise<void> {
    const config = this.config();
    if (this.mcp) throw new AppError("mcp_started", "MCP 连接已启动。");
    this.mcpSecrets = Object.values(environment).filter(Boolean);
    // 连接凭证仅进入指定 MCP 子进程；不保存到 intent、回执或普通日志。
    this.mcpTransport = new SandboxStdioTransport(
      command,
      args.map((value) =>
        value.replaceAll("{{workspace}}", config.workspace.path),
      ),
      config.workspace.path,
      {
        ...executionEnvironment(config.scratchDir),
        ...(config.executionMode === "full_access" && config.userHome
          ? { HOME: config.userHome }
          : {}),
        ...environment,
      },
      config.executionMode,
    );
    this.mcp = new Client(
      { name: "myagent", version: "0.2.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    this.mcp.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [
        {
          uri: pathToFileURL(config.workspace.path).toString(),
          name: config.workspace.name,
        },
      ],
    }));
    this.mcp.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.notify({ type: "mcp_catalog_changed" });
    });
    await this.mcp.connect(this.mcpTransport, { timeout: 15000 });
  }
  async listMcp(): Promise<JsonValue> {
    if (!this.mcp) throw new AppError("mcp_disconnected", "MCP 未连接。");
    const tools: JsonValue[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.mcp.listTools(cursor ? { cursor } : {});
      tools.push(...(JSON.parse(JSON.stringify(page.tools)) as JsonValue[]));
      cursor = page.nextCursor;
      if (tools.length > 5000 || JSON.stringify(tools).length > 5 * 1024 * 1024)
        throw new AppError("mcp_catalog_limit", "MCP 工具目录超过限制。");
    } while (cursor);
    return tools;
  }
  async callMcp(execution: WorkerExecution): Promise<ExecutionReceipt> {
    const config = this.config();
    if (!this.mcp) throw new AppError("mcp_disconnected", "MCP 未连接。");
    const path = join(config.recordDir, `${execution.attemptId}.receipt.json`);
    if (existsSync(path))
      return JSON.parse(await readFile(path, "utf8")) as ExecutionReceipt;
    const controller = new AbortController();
    this.mcpControllers.set(execution.attemptId, controller);
    await durableJson(
      join(config.recordDir, `${execution.attemptId}.intent.json`),
      {
        name: execution.name,
        invocationId: execution.invocationId,
        acceptedAt: new Date().toISOString(),
      },
    );
    try {
      const result = await this.mcp.callTool(
        { name: execution.name, arguments: execution.arguments },
        undefined,
        { signal: controller.signal, timeout: execution.timeoutMs },
      );
      const redact = (value: JsonValue): JsonValue => {
        if (typeof value === "string")
          return this.mcpSecrets.reduce(
            (text, secret) => text.replaceAll(secret, "[已隐藏凭证]"),
            value,
          );
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, redact(item)]),
          );
        return value;
      };
      const data = redact(JSON.parse(JSON.stringify(result)) as JsonValue);
      const receipt = this.receipt(
        execution,
        result.isError ? "failed" : "succeeded",
        data,
        result.isError
          ? {
              code: "mcp_tool_error",
              message: "MCP 工具返回执行错误，请查看结果。",
            }
          : null,
        true,
      );
      await durableJson(path, receipt);
      return receipt;
    } finally {
      this.mcpControllers.delete(execution.attemptId);
    }
  }
}
/** 仅父进程 IPC 可调用；没有网络监听端口，异常只转换成安全错误。 */
export function runExecutionWorker(): void {
  const runtime = new NativeWorkerRuntime((event) => {
    if (process.connected) process.send?.(event);
  });
  process.on("message", (message: WorkerRequest) => {
    void (async () => {
      let response: WorkerReply;
      try {
        if (message.method === "initialize") {
          await runtime.initialize(message.configuration);
          response = { id: message.id, ok: true };
        } else if (message.method === "execute")
          response = {
            id: message.id,
            ok: true,
            receipt: await runtime.execute(message.execution),
          };
        else if (message.method === "cancel") {
          await runtime.cancel(message.attemptId);
          response = { id: message.id, ok: true };
        } else if (message.method === "mcp_connect") {
          await runtime.connectMcp(
            message.command,
            message.args,
            message.environment,
          );
          response = { id: message.id, ok: true };
        } else if (message.method === "mcp_list")
          response = {
            id: message.id,
            ok: true,
            data: await runtime.listMcp(),
          };
        else if (message.method === "mcp_call")
          response = {
            id: message.id,
            ok: true,
            receipt: await runtime.callMcp(message.execution),
          };
        else {
          response = {
            id: message.id,
            ok: true,
            data: { confirmed: await runtime.close() },
          };
        }
      } catch (error) {
        response = { id: message.id, ok: false, error: safe(error) };
      }
      if (process.connected) process.send?.(response);
      if (message.method === "close") process.disconnect?.();
    })();
  });
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void runtime.close().finally(() => process.exit(0));
  };
  process.on("disconnect", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
