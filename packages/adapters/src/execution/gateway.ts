/**
 * 本机执行网关：按 Run 与授权配置创建独立 Worker，通过 IPC 派发、取消并读取持久回执。
 * Worker 的 stdout/stderr 不进入普通日志；模型凭证不随环境变量传给任何子进程。
 */
import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppError,
  type ExecutionAttempt,
  type ExecutionReceipt,
  type JsonValue,
  type ProcessSession,
  type WorkerCatalogEvent,
  type WorkerConfiguration,
  type WorkerProcessEvent,
  type WorkerReply,
  type WorkerRequest,
} from "@myagent/contracts";
import {
  type DispatchRequest,
  type ExecutionGateway,
  raceSignal,
} from "@myagent/kernel";
import { builtinTools, LocalToolExecutor } from "../tools/index.js";
import { digest } from "./paths.js";
import {
  processBirthTime,
  processGroupExists,
  terminateProcessGroup,
} from "./process-groups.js";
import { executionEnvironment } from "./worker-runtime.js";

type WorkerMessage = WorkerReply | WorkerProcessEvent | WorkerCatalogEvent;
type WorkerMethod = WorkerRequest extends infer T
  ? T extends WorkerRequest
    ? Omit<T, "id">
    : never
  : never;
export class WorkerClient {
  readonly child: ChildProcess;
  readonly pending = new Map<
    string,
    {
      resolve: (response: WorkerReply) => void;
      reject: (error: unknown) => void;
    }
  >();
  alive = true;
  constructor(
    entry: string,
    scratch: string,
    onProcess: (event: WorkerProcessEvent | WorkerCatalogEvent) => void,
  ) {
    this.child = fork(entry, [], {
      env: executionEnvironment(scratch),
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child.on("message", (message: WorkerMessage) => {
      if ("type" in message) {
        onProcess(message);
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message);
      else
        waiter.reject(
          new AppError(
            message.error?.code ?? "worker_error",
            message.error?.message ?? "执行 Worker 失败。",
          ),
        );
    });
    const failed = () => {
      this.alive = false;
      for (const waiter of this.pending.values())
        waiter.reject(
          new AppError(
            "worker_lost",
            "执行 Worker 已退出，需要核对执行结果。",
            503,
          ),
        );
      this.pending.clear();
    };
    this.child.on("exit", failed);
    this.child.on("error", failed);
  }
  async request(message: WorkerMethod, timeout = 35000): Promise<WorkerReply> {
    if (!this.alive)
      throw new AppError("worker_lost", "执行 Worker 已退出。", 503);
    const id = randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    return new Promise<WorkerReply>((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError(
            "worker_timeout",
            "等待 Worker 回执超时，需核对执行结果。",
            504,
          ),
        );
      }, timeout);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.send({ ...message, id }, (error) => {
        if (error) {
          const waiter = this.pending.get(id);
          this.pending.delete(id);
          waiter?.reject(
            new AppError("worker_lost", "无法向 Worker 派发操作。", 503),
          );
        }
      });
    });
  }
  async close(): Promise<boolean> {
    if (!this.alive) return false;
    try {
      const response = await this.request({ method: "close" }, 10000);
      return Boolean(
        response.data &&
          typeof response.data === "object" &&
          !Array.isArray(response.data) &&
          response.data.confirmed,
      );
    } catch {
      this.child.kill("SIGTERM");
      return false;
    }
  }
}
interface WorkerRecord {
  client: WorkerClient;
  configuration: WorkerConfiguration;
  runId: string;
  ready: Promise<void>;
  events: Promise<void>;
  eventError: unknown;
}
export interface GatewayOptions {
  dataDir: string;
  runtimeRoot: string;
  protectedPaths: string[];
  readOnlyPaths?: (runId: string) => string[];
  prepareResources?: (runId: string, signal: AbortSignal) => Promise<void>;
  onProcess?: (event: WorkerProcessEvent) => Promise<void> | void;
  /** MCP 与按需目录能力由 Server 装配，网关只按注册来源路由，不运行模型。 */
  customDispatch?: (
    request: DispatchRequest,
    signal: AbortSignal,
  ) => Promise<JsonValue>;
}
export class NativeExecutionGateway implements ExecutionGateway {
  private readonly workers = new Map<string, WorkerRecord>();
  // 同一 Run / 权限范围的首次初始化共享 Promise，避免并行工具覆盖注册项而遗留进程。
  private readonly starting = new Map<
    string,
    { runId: string; promise: Promise<WorkerRecord> }
  >();
  private closing = false;
  private readonly processRecords = new Map<string, ProcessSession>();
  private readonly outputPaths = new Map<string, string>();
  private readonly processOwners = new Map<string, WorkerRecord>();
  private readonly attempts = new Map<string, WorkerRecord>();
  private readonly local = new LocalToolExecutor(builtinTools());
  constructor(private readonly options: GatewayOptions) {}
  private async worker(request: DispatchRequest): Promise<WorkerRecord> {
    const workspace = request.context.workspace;
    if (!workspace)
      throw new AppError("workspace_required", "请先绑定工作区。", 409);
    const readOnly = request.prepared.readOnlyExecution === true;
    const resources =
      request.hook || readOnly
        ? request.authorizedResources
        : [
            {
              kind: "path" as const,
              target: workspace.path,
              access: readOnly ? ("read" as const) : ("write" as const),
            },
            ...request.authorizedResources.filter(
              (resource) =>
                resource.kind !== "path" ||
                !(
                  resource.target === workspace.path ||
                  resource.target.startsWith(`${workspace.path}/`)
                ),
            ),
          ];
    const key = digest(
      JSON.stringify([
        request.context.runId,
        request.hook || readOnly
          ? "standard"
          : (request.context.executionMode ?? "standard"),
        workspace.identity,
        resources,
        request.hook?.readOnlyPaths ?? null,
        readOnly,
      ]),
    );
    if (this.closing)
      throw new AppError("unavailable", "执行网关正在关闭。", 503);
    const initializing = this.starting.get(key);
    if (initializing) return initializing.promise;
    const existing = this.workers.get(key);
    if (existing?.client.alive) {
      await existing.ready;
      return existing;
    }
    if (existing) this.workers.delete(key);
    const promise = (async () => {
      const workerId = randomUUID();
      const scratchDir = await realpath(
        await mkdtemp(join(tmpdir(), "myagent-exec-")),
      );
      const recordDir = join(this.options.dataDir, "execution", workerId);
      await mkdir(recordDir, { recursive: true, mode: 0o700 });
      const configuration: WorkerConfiguration = {
        // Hook 保持配置时声明的独立权限；本轮模式只控制模型工具执行。
        executionMode:
          request.hook || readOnly
            ? "standard"
            : (request.context.executionMode ?? "standard"),
        origin: request.hook ? "hook" : "tool",
        workerId,
        workspace,
        resources,
        protectedPaths: this.options.protectedPaths,
        readOnlyPaths:
          request.hook?.readOnlyPaths ??
          this.options.readOnlyPaths?.(request.context.runId) ??
          [],
        userHome: homedir(),
        runtimeRoot: this.options.runtimeRoot,
        actionPath: fileURLToPath(
          new URL("../../../../apps/worker/dist/action.js", import.meta.url),
        ),
        recordDir,
        scratchDir,
      };
      let record: WorkerRecord;
      const client = new WorkerClient(
        fileURLToPath(
          new URL("../../../../apps/worker/dist/main.js", import.meta.url),
        ),
        scratchDir,
        (event) => {
          if (event.type !== "process") return;
          this.processRecords.set(event.process.id, event.process);
          this.outputPaths.set(event.process.id, event.outputPath);
          this.processOwners.set(event.process.id, record);
          record.events = record.events
            .then(async () => {
              await this.options.onProcess?.(event);
            })
            .catch((error) => {
              record.eventError = error;
              void record.client.close();
            });
        },
      );
      record = {
        client,
        configuration,
        runId: request.context.runId,
        ready: Promise.resolve(),
        events: Promise.resolve(),
        eventError: null,
      };
      this.workers.set(key, record);
      record.ready = client
        .request({ method: "initialize", configuration }, 15000)
        .then(() => {})
        .catch(async (error) => {
          await client.close();
          // 沙箱探测失败尚未派发动作；移除未就绪 Worker，不能把它误当成未知运行进程。
          if (this.workers.get(key) === record) this.workers.delete(key);
          throw error;
        });
      await record.ready;
      return record;
    })();
    this.starting.set(key, { runId: request.context.runId, promise });
    try {
      return await promise;
    } finally {
      if (this.starting.get(key)?.promise === promise)
        this.starting.delete(key);
    }
  }
  async dispatch(
    request: DispatchRequest,
    signal: AbortSignal,
  ): Promise<ExecutionReceipt> {
    const { descriptor, arguments: args } = request.prepared;
    if (
      descriptor.source.kind === "mcp" ||
      [
        "search_skills",
        "load_skill",
        "read_skill_resource",
        "search_tools",
        "read_tool_result",
        "read_conversation_history",
        "search_memories",
        "read_memory",
        "update_memory",
      ].includes(descriptor.name)
    ) {
      if (!this.options.customDispatch)
        throw new AppError("tool_unavailable", "工具适配器未装配。");
      if (descriptor.source.kind !== "mcp") await request.onAccepted?.(null);
      const data = await this.options.customDispatch(request, signal);
      const failed =
        descriptor.source.kind === "mcp" &&
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        data.isError === true;
      return {
        attemptId: request.attemptId,
        invocationId: request.context.invocationId,
        outcome: failed ? "failed" : "succeeded",
        data,
        error: failed
          ? {
              code: "mcp_tool_error",
              message: "MCP 工具返回执行错误，请查看结果。",
            }
          : null,
        effectsPossible: descriptor.effects !== "read",
        completedAt: new Date().toISOString(),
      };
    }
    if (
      this.local.definitions.some(
        (definition) => definition.name === descriptor.name,
      )
    ) {
      await request.onAccepted?.(null);
      signal.throwIfAborted();
      const data = await this.local.execute(
        {
          id: request.context.invocationId,
          name: descriptor.name,
          arguments: JSON.stringify(args),
        },
        request.context,
        signal,
      );
      return {
        attemptId: request.attemptId,
        invocationId: request.context.invocationId,
        outcome: "succeeded",
        data,
        error: null,
        effectsPossible: false,
        completedAt: new Date().toISOString(),
      };
    }
    // 恢复可能直接继续待批准工具批次，先恢复受信资源，不能依赖下一次模型上下文准备。
    await this.options.prepareResources?.(request.context.runId, signal);
    const processId =
      typeof args.processId === "string" ? args.processId : null;
    const recovered = processId ? this.processRecords.get(processId) : null;
    if (
      recovered &&
      recovered.runId === request.context.runId &&
      !this.processOwners.has(recovered.id) &&
      descriptor.name === "read_process"
    ) {
      return {
        attemptId: request.attemptId,
        invocationId: request.context.invocationId,
        outcome: "succeeded",
        data: {
          processId: recovered.id,
          status: recovered.status,
          exitCode: recovered.exitCode,
          signal: recovered.signal,
          outputRef: recovered.outputRef,
          note: "这是恢复后的持久进程记录；完整输出通过 read_tool_result 读取，旧标准输入不能继续写入。",
        },
        error: null,
        effectsPossible: false,
        completedAt: new Date().toISOString(),
      };
    }
    const record = processId
      ? this.processOwners.get(processId)
      : await this.worker(request);
    if (!record || record.runId !== request.context.runId)
      throw new AppError("process_not_found", "当前 Run 中不存在该进程。", 404);
    this.attempts.set(request.attemptId, record);
    await request.onAccepted?.(record.configuration.workerId);
    signal.throwIfAborted();
    const execution = {
      attemptId: request.attemptId,
      invocationId: request.context.invocationId,
      runId: request.context.runId,
      sessionId: request.context.sessionId,
      ...(request.hook ? { hook: request.hook } : {}),
      name: descriptor.name,
      arguments: args,
      resources: request.hook
        ? request.authorizedResources
        : [
            {
              kind: "path" as const,
              target: record.configuration.workspace.path,
              access: "write" as const,
            },
            ...request.authorizedResources,
          ],
      timeoutMs: request.timeoutMs,
    };
    const cancel = () => {
      void record.client
        .request({ method: "cancel", attemptId: request.attemptId }, 7000)
        .catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await raceSignal(
        record.client.request(
          { method: "execute", execution },
          request.timeoutMs + 10000,
        ),
        signal,
      );
      await record.events;
      if (record.eventError)
        throw new AppError(
          "execution_storage",
          "进程状态或完整输出保存失败，需要核对执行结果。",
          500,
        );
      if (!response.receipt)
        throw new AppError("worker_protocol", "Worker 未返回执行回执。");
      const data = response.receipt.data;
      if (
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        typeof data.processId === "string"
      ) {
        const outputRef = this.processRecords.get(data.processId)?.outputRef;
        if (outputRef) data.outputRef = outputRef;
      }
      return response.receipt;
    } catch (error) {
      if (signal.aborted) {
        await record.client
          .request({ method: "cancel", attemptId: request.attemptId }, 7000)
          .catch(() => {});
        const receipt = await this.reconcile(request.attemptId);
        if (receipt) return receipt;
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  async cancelAttempt(attemptId: string): Promise<void> {
    const record = this.attempts.get(attemptId);
    if (!record) return;
    await record.client.request({ method: "cancel", attemptId }, 7000);
    await record.events;
  }
  async reconcile(
    attemptId: string,
    workerId?: string | null,
  ): Promise<ExecutionReceipt | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(attemptId)) return null;
    const record = this.attempts.get(attemptId);
    if (record)
      try {
        return JSON.parse(
          await readFile(
            join(record.configuration.recordDir, `${attemptId}.receipt.json`),
            "utf8",
          ),
        ) as ExecutionReceipt;
      } catch {
        return null;
      }
    if (workerId && /^[a-zA-Z0-9_-]+$/.test(workerId))
      try {
        return JSON.parse(
          await readFile(
            join(
              this.options.dataDir,
              "execution",
              workerId,
              `${attemptId}.receipt.json`,
            ),
            "utf8",
          ),
        ) as ExecutionReceipt;
      } catch {
        return null;
      }
    // 缺少可验证的回执只能返回未知，不能从没有文件推断没有执行。
    return null;
  }
  outputPath(processId: string): string | null {
    return this.outputPaths.get(processId) ?? null;
  }
  async recoverProcesses(records: ProcessSession[]): Promise<void> {
    for (const process of records) {
      if (process.status !== "running" && process.status !== "unknown")
        continue;
      if (
        !/^[a-zA-Z0-9_-]+$/.test(process.workerId) ||
        !/^[a-zA-Z0-9_-]+$/.test(process.id)
      )
        continue;
      const path = join(
        this.options.dataDir,
        "execution",
        process.workerId,
        `${process.id}.process.json`,
      );
      let saved: ProcessSession | null = null;
      try {
        saved = JSON.parse(await readFile(path, "utf8")) as ProcessSession;
      } catch {
        /* 缺少回执仍保持未知。 */
      }
      const birth = saved?.birthTime ?? process.birthTime;
      const current = await processBirthTime(process.pid);
      if (
        saved &&
        saved.id === process.id &&
        (saved.status === "stopped" || saved.status === "exited") &&
        !processGroupExists(process.pid)
      )
        Object.assign(process, saved);
      else if (birth && current === birth) {
        const confirmed = await terminateProcessGroup(process.pid);
        process.status = confirmed ? "stopped" : "unknown";
        process.endedAt = new Date().toISOString();
        process.signal = confirmed ? "SIGTERM/SIGKILL" : null;
      } else {
        process.status = "unknown";
        process.endedAt = new Date().toISOString();
      }
      this.processRecords.set(process.id, process);
      const outputPath = join(
        this.options.dataDir,
        "execution",
        process.workerId,
        `${process.id}.output.txt`,
      );
      this.outputPaths.set(process.id, outputPath);
      await this.options.onProcess?.({ type: "process", process, outputPath });
    }
  }
  processes(runId: string): ProcessSession[] {
    return [...this.processRecords.values()]
      .filter((item) => item.runId === runId)
      .map((item) => structuredClone(item));
  }
  async closeRun(runId: string): Promise<{ confirmed: boolean }> {
    await Promise.allSettled(
      [...this.starting.values()]
        .filter((p) => p.runId === runId)
        .map((p) => p.promise),
    );
    const records = [...this.workers.entries()].filter(
      ([, record]) => record.runId === runId,
    );
    const outcomes = await Promise.all(
      records.map(async ([key, record]) => {
        const confirmed = await record.client.close();
        await record.events;
        if (confirmed) {
          await rm(record.configuration.scratchDir, {
            recursive: true,
            force: true,
          });
          this.workers.delete(key);
        }
        return confirmed && !record.eventError;
      }),
    );
    return {
      confirmed:
        outcomes.every(Boolean) &&
        this.processes(runId).every(
          (process) =>
            process.status !== "running" && process.status !== "unknown",
        ),
    };
  }
  /** 仅清理数据库列出的已终结会话记录，不扫描或删除用户工作区。 */
  async deleteRecords(
    attempts: ExecutionAttempt[],
    processes: ProcessSession[],
  ): Promise<void> {
    const valid = (value: string) => /^[a-zA-Z0-9_-]+$/.test(value);
    for (const attempt of attempts)
      if (attempt.workerId && valid(attempt.workerId) && valid(attempt.id)) {
        for (const suffix of ["intent.json", "receipt.json"])
          await rm(
            join(
              this.options.dataDir,
              "execution",
              attempt.workerId,
              `${attempt.id}.${suffix}`,
            ),
            { force: true },
          );
        this.attempts.delete(attempt.id);
      }
    for (const process of processes)
      if (valid(process.workerId) && valid(process.id)) {
        for (const suffix of ["process.json", "output.txt"])
          await rm(
            join(
              this.options.dataDir,
              "execution",
              process.workerId,
              `${process.id}.${suffix}`,
            ),
            { force: true },
          );
        this.processRecords.delete(process.id);
        this.outputPaths.delete(process.id);
        this.processOwners.delete(process.id);
      }
  }
  async revoke(workspaceId: string): Promise<void> {
    await Promise.all(
      [...this.workers.entries()]
        .filter(
          ([, record]) => record.configuration.workspace.id === workspaceId,
        )
        .map(async ([key, record]) => {
          const confirmed = await record.client.close();
          await record.events;
          if (confirmed) {
            this.workers.delete(key);
            await rm(record.configuration.scratchDir, {
              recursive: true,
              force: true,
            });
          }
        }),
    );
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.starting.values()].map((p) => p.promise));
    await Promise.all(
      [
        ...new Set([...this.workers.values()].map((record) => record.runId)),
      ].map((id) => this.closeRun(id)),
    );
  }
}
