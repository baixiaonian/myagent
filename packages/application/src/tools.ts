/**
 * 工具执行应用服务：串接注册校验、权限/审批、资源锁、真实派发、持久结果及恢复核对。
 * Loop 只调用本服务提供的批次端口；这里不调用模型，也不替模型制定计划或自动重试动作。
 */
import {
  AppError,
  type ApprovalDecision,
  type ApprovalRequest,
  EXECUTION_LIMITS,
  type ExecutionAttempt,
  type ExecutionConcern,
  type ExecutionOverview,
  type ExecutionReceipt,
  type JsonValue,
  type PermissionGrant,
  type ProcessSession,
  type ToolCall,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolInvocation,
  type ToolResult,
  type Workspace,
} from "@myagent/contracts";
import {
  coversResource,
  createToolPreview,
  type DispatchRequest,
  type ExecutionContext,
  type ExecutionGateway,
  evaluatePermissions,
  modelResultValue,
  type PreparedTool,
  previewSavedResult,
  type ResultStorePort,
  scheduleBatch,
  type ToolBatchOptions,
  type ToolExecutor,
  type ToolRegistryPort,
  type WorkspacePort,
} from "@myagent/kernel";
import type { ChatStore, ExecutionStore } from "@myagent/state";
import type { CommandPolicyService } from "./command-policy.js";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import type { HookService } from "./hooks.js";
import { McpToolSelection } from "./tool-selection.js";

export interface ToolServiceOptions {
  grantSession?: (sessionId: string) => string;
  allowed?: (runId: string, name: string) => boolean;
  control?: {
    accepts(name: string): boolean;
    execute(
      runId: string,
      invocationId: string,
      name: string,
      args: Record<string, JsonValue>,
      signal: AbortSignal,
      commit: (value: JsonValue) => void,
    ): Promise<void>;
    pauseWait(error: unknown): boolean;
  };
  pluginAllowed?: (
    connectionId: string,
    workspaceId: string,
    runId?: string,
  ) => boolean;
  coordinator?: ExecutionCoordinator;
  hooks?: HookService;
  store: ExecutionStore;
  chat: ChatStore;
  registry: ToolRegistryPort;
  gateway: ExecutionGateway;
  results: ResultStorePort;
  workspaces: WorkspacePort;
  id: () => string;
  commands?: CommandPolicyService;
  trustedReadPaths?: (runId: string) => string[];
  commitResult?: (invocation: ToolInvocation, result: ToolResult) => void;
  revokeExternal?: (workspaceId: string) => Promise<void>;
}
interface BatchItem {
  call: ToolCall;
  invocation: ToolInvocation;
  prepared: PreparedTool | null;
  context: ExecutionContext;
  error: AppError | null;
}
function safe(error: unknown): AppError {
  return error instanceof AppError
    ? error
    : new AppError("tool_failed", "工具执行失败，请检查执行记录。");
}
function terminal(invocation: ToolInvocation): boolean {
  return (
    ["succeeded", "failed", "denied", "cancelled"].includes(
      invocation.status,
    ) ||
    (invocation.status === "unknown" && Boolean(invocation.resolution))
  );
}
export class ToolService {
  observer?: import("@myagent/observability").ObserverPort;
  private readonly coordinator: ExecutionCoordinator;
  private get slots() {
    return this.coordinator.slots;
  }
  private readonly processLeases = new Map<
    string,
    { runId: string; release: () => void }
  >();
  private readonly executors = new Map<string, ToolExecutor>();
  private readonly snapshots = new Map<string, Map<string, ToolDescriptor>>();
  private readonly selection: McpToolSelection;
  constructor(readonly options: ToolServiceOptions) {
    this.coordinator = options.coordinator ?? new ExecutionCoordinator();
    this.selection = new McpToolSelection(
      options.store,
      options.registry,
      options.pluginAllowed,
    );
  }
  /** 与新 Run 的创建处于同一事务；只复用同一会话的有效引用，不恢复执行动作。 */
  initializeRunTools(runId: string, sessionId: string): void {
    const workspace = this.workspace(sessionId);
    this.selection.save(
      runId,
      workspace,
      this.selection.inherit(sessionId, workspace, runId),
    );
  }
  workspace(sessionId: string): Workspace | null {
    const workspaceId =
      this.options.chat.snapshot(sessionId).session.workspaceId;
    return workspaceId
      ? this.options.store.get("workspaces", workspaceId)
      : null;
  }
  async createWorkspace(path: string, name: string): Promise<Workspace> {
    const candidate = await this.options.workspaces.create(path, name);
    const existing = this.options.store
      .list("workspaces")
      .find((workspace) => workspace.path === candidate.path);
    if (existing && existing.identity === candidate.identity) {
      await this.options.workspaces.validate(existing);
      return existing;
    }
    this.options.store.put("workspaces", candidate);
    return candidate;
  }
  overview(sessionId: string): ExecutionOverview {
    this.options.chat.snapshot(sessionId);
    return {
      workspace: this.workspace(sessionId),
      approvals: this.options.store.list("approvals", { sessionId }),
      invocations: this.options.store.list("invocations", { sessionId }),
      processes: this.options.store.list("processes", { sessionId }),
      concerns: this.concerns(),
    };
  }
  private available(runId: string, sessionId: string): ToolDescriptor[] {
    const workspace = this.workspace(sessionId);
    const loaded = this.selection.valid(
      this.options.store.get("checkpoints", runId)?.loadedToolBindings ?? [],
      workspace,
      runId,
    );
    return this.options.registry.descriptors().filter((descriptor) => {
      if (this.options.allowed && !this.options.allowed(runId, descriptor.name))
        return false;
      if (descriptor.requiresWorkspace && !workspace) return false;
      if (descriptor.source.kind === "local") return true;
      if (
        (descriptor.source.executionMode ?? "standard") !==
        (this.options.chat.getRun(runId).executionMode ?? "standard")
      )
        return false;
      const connection = this.options.store.get(
        "connections",
        descriptor.source.connectionId,
      );
      return Boolean(
        this.selection.eligible(descriptor, workspace, runId) &&
          // 直接提供的服务无需先搜索；两种方式始终受同一项目、启用与信任条件约束。
          (connection?.toolExposure === "direct" ||
            loaded.some(
              (tool) =>
                tool.name === descriptor.name &&
                tool.version === descriptor.version,
            )),
      );
    });
  }
  forRun(runId: string, sessionId: string): ToolExecutor {
    const existing = this.executors.get(runId);
    if (existing) return existing;
    const service = this;
    const executor: ToolExecutor = {
      get definitions() {
        return service.available(runId, sessionId);
      },
      async snapshot() {
        service.releaseFinishedProcesses(runId);
        const descriptors = service.available(runId, sessionId);
        service.snapshots.set(
          runId,
          new Map(
            descriptors.map((descriptor) => [descriptor.name, descriptor]),
          ),
        );
        return descriptors.map(
          ({ name, description, parameters }): ToolDefinition => ({
            name,
            description,
            parameters,
          }),
        );
      },
      execute: async () => {
        throw new AppError(
          "batch_required",
          "受控工具只能通过完整批次端口执行。",
        );
      },
      executeBatch: (options) => service.executeBatch(options, sessionId),
    };
    this.executors.set(runId, executor);
    return executor;
  }
  /** 检索是工具目录动作；不运行额外模型，不因加载定义而自动批准执行。 */
  searchTools(
    runId: string,
    query: string,
    cursor = "0",
    limit = 5,
  ): JsonValue {
    const checkpoint = this.options.store.get("checkpoints", runId);
    if (!checkpoint)
      throw new AppError("checkpoint_missing", "缺少运行检查点。");
    const workspace = this.workspace(checkpoint.sessionId);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const descriptors = this.options.registry.descriptors();
    const deferred = descriptors.filter((tool) => {
      if (
        tool.source.kind !== "mcp" ||
        (tool.source.executionMode ?? "standard") !==
          (this.options.chat.getRun(runId).executionMode ?? "standard") ||
        !this.selection.eligible(tool, workspace, runId)
      )
        return false;
      const connection = this.options.store.get(
        "connections",
        tool.source.connectionId,
      );
      // 搜索仅处理按需服务；直接提供的定义不占用搜索名额和 loadedTools 的预算。
      return connection?.toolExposure !== "direct";
    });
    const candidates = deferred
      .filter((tool) =>
        words.every((word) =>
          `${tool.name} ${tool.description} ${tool.source.kind === "mcp" ? tool.source.originalName : ""}`
            .toLowerCase()
            .includes(word),
        ),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const offset = Number(cursor);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 5
    )
      throw new AppError("invalid_cursor", "工具检索分页参数无效。");
    const selected = candidates.slice(offset, offset + limit);
    const ordered = [
      ...this.selection
        .valid(checkpoint.loadedToolBindings ?? [], workspace, runId)
        .filter((old) => !selected.some((tool) => tool.name === old.name)),
      ...selected.map((tool) => this.selection.binding(tool)),
    ];
    const { tools, evicted } = this.selection.trim(ordered);
    this.selection.save(runId, workspace, tools);
    return {
      tools: selected.map((tool) => ({
        name: tool.name,
        description: tool.description,
        loaded: tools.some((loaded) => loaded.name === tool.name),
      })),
      evicted,
      cursor:
        offset + limit < candidates.length ? String(offset + limit) : null,
      note: "已加载工具从下一次请求可用，并在同一会话中复用仍有效的定义；过大的定义无法加载，权限仍在真实调用时检查。",
    };
  }
  private async executeBatch(
    batch: ToolBatchOptions,
    sessionId: string,
  ): Promise<ToolResult[]> {
    const workspace = this.workspace(sessionId);
    const stored = this.options.store.list("invocations", {
      runId: batch.runId,
    });
    const items: BatchItem[] = [];
    // 整批参数先准备，所有逻辑调用在第一次真实动作前有稳定身份与定义版本。
    for (const [ordinal, call] of batch.calls.entries()) {
      const existing = stored.find(
        (item) => item.stepId === batch.stepId && item.callId === call.id,
      );
      const context: ExecutionContext = {
        runId: batch.runId,
        executionMode:
          this.options.chat.getRun(batch.runId).executionMode ?? "standard",
        sessionId,
        stepId: batch.stepId,
        invocationId: existing?.id ?? this.options.id(),
        workspace,
      };
      let prepared: PreparedTool | null = null;
      let error: AppError | null = null;
      const validation = this.observer?.span(
        {
          runId: batch.runId,
          sessionId,
          stepId: batch.stepId,
          invocationId: context.invocationId,
        },
        "tool.validate",
        { "gen_ai.tool.name": call.name },
      );
      try {
        if (!existing && !this.snapshots.get(batch.runId)?.has(call.name))
          throw new AppError(
            "unknown_tool",
            "工具未在本次模型请求中提供，请先检索可用工具。",
          );
        prepared = await this.options.registry.prepare(
          call.name,
          call.arguments,
          context,
        );
        const version =
          existing?.toolVersion ??
          this.snapshots.get(batch.runId)?.get(call.name)?.version;
        if (version && version !== prepared.descriptor.version)
          throw new AppError(
            "tool_changed",
            "工具定义已变化，本次操作没有执行，请重新检索。",
          );
      } catch (cause) {
        error = safe(cause);
      } finally {
        validation?.end(error ? "failed" : "succeeded");
      }
      const invocation: ToolInvocation = existing ?? {
        origin: "tool",
        executionMode: context.executionMode ?? "standard",
        id: context.invocationId,
        sessionId,
        runId: batch.runId,
        stepId: batch.stepId,
        callId: call.id,
        ordinal,
        toolName: call.name,
        toolVersion: prepared?.descriptor.version ?? "unavailable",
        source: prepared?.descriptor.source ?? { kind: "local" },
        arguments: call.arguments,
        fingerprint: prepared?.fingerprint ?? "",
        resources: prepared?.resources ?? [],
        effects: prepared?.descriptor.effects ?? "read",
        status: "prepared",
        result: null,
        createdAt: new Date().toISOString(),
        endedAt: null,
      };
      if (!existing) this.options.store.put("invocations", invocation);
      items.push({ call, invocation, prepared, context, error });
    }
    const results: ToolResult[] = Array.from({ length: items.length });
    const controller = new AbortController();
    const abort = () => controller.abort(batch.signal.reason);
    batch.signal.addEventListener("abort", abort, { once: true });
    if (batch.signal.aborted) abort();
    try {
      await scheduleBatch(
        items,
        (item) =>
          !this.options.hooks?.hasToolHooks(
            batch.runId,
            items.map((i) => i.call.name),
          ) && item.prepared?.descriptor.concurrency === "shared",
        async (item, index) => {
          this.releaseFinishedProcesses(batch.runId);
          try {
            const activeBatch = { ...batch, signal: controller.signal };
            // Hook 在业务动作的锁外串行执行，防止格式化和读取争用、以及递归获取自身锁。
            if (!item.error && item.prepared && !terminal(item.invocation)) {
              const decision = await this.options.hooks?.trigger(
                batch.runId,
                "PreToolUse",
                `pre:${item.invocation.id}`,
                controller.signal,
                item.invocation,
              );
              if (decision?.decision === "deny") {
                results[index] = await this.failed(
                  item,
                  new AppError(
                    "hook_denied",
                    decision.reason ?? "前置 Hook 拒绝执行。",
                  ),
                  activeBatch,
                  index,
                  "denied",
                );
                return;
              }
            }
            results[index] = await this.executeItem(item, activeBatch, index);
            // 只有真实派发且取得已知成功/失败回执才触发；恢复也复用事件身份，不重做已完成 Hook。
            if (
              ["succeeded", "failed"].includes(item.invocation.status) &&
              this.options.store
                .list("attempts", { runId: batch.runId })
                .some(
                  (a) =>
                    a.invocationId === item.invocation.id &&
                    a.status === "completed" &&
                    Boolean(a.acceptedAt || a.workerId),
                )
            )
              await this.options.hooks?.trigger(
                batch.runId,
                "PostToolUse",
                `post:${item.invocation.id}`,
                controller.signal,
                item.invocation,
              );
          } catch (error) {
            if (
              !(
                error instanceof AppError && error.code === "execution_paused"
              ) ||
              this.options.chat.getRun(batch.runId).status ===
                "waiting_reconciliation"
            )
              controller.abort(error);
            throw error;
          }
        },
        EXECUTION_LIMITS.runConcurrency,
        controller.signal,
      );
    } finally {
      batch.signal.removeEventListener("abort", abort);
    }
    return results;
  }
  private async executeItem(
    item: BatchItem,
    batch: ToolBatchOptions,
    index: number,
  ): Promise<ToolResult> {
    const { invocation, context, prepared } = item;
    const toolSpan = this.observer?.span(
      {
        runId: batch.runId,
        sessionId: context.sessionId,
        stepId: batch.stepId,
        invocationId: invocation.id,
      },
      "tool.execute",
      {
        "gen_ai.tool.name": invocation.toolName,
        "myagent.execution_mode": context.executionMode ?? "standard",
      },
    );
    const observed = {
      runId: batch.runId,
      sessionId: context.sessionId,
      stepId: batch.stepId,
      invocationId: invocation.id,
      ...(toolSpan?.id ? { parentSpanId: toolSpan.id } : {}),
    };
    try {
      if (terminal(invocation) && invocation.result) {
        await batch.onUpdate(
          index,
          invocation.status === "unknown"
            ? "unknown"
            : invocation.result.ok
              ? "succeeded"
              : "failed",
          invocation.result,
        );
        return invocation.result;
      }
      if (invocation.status === "unknown" && !invocation.resolution)
        this.pause(batch.runId, "waiting_reconciliation");
      if (item.error || !prepared)
        return this.failed(
          item,
          item.error ?? new AppError("tool_failed", "工具未准备完成。"),
          batch,
          index,
        );
      const blocked = this.concerns().find(
        (other) =>
          other.id !== invocation.id &&
          other.resources.some((a) =>
            prepared.resources.some((b) =>
              a.kind === "mcp" && b.kind === "mcp"
                ? a.target.split("/")[0] === b.target.split("/")[0]
                : coversResource(a, b) || coversResource(b, a),
            ),
          ),
      );
      if (blocked) this.pause(batch.runId, "waiting_reconciliation");
      try {
        await this.authorize(item, batch, index);
      } catch (error) {
        if (error instanceof AppError && error.code === "execution_paused")
          throw error;
        return this.failed(item, safe(error), batch, index, "denied");
      }
      if (
        this.options.allowed &&
        !this.options.allowed(batch.runId, prepared.descriptor.name)
      )
        return this.failed(
          item,
          new AppError("agent_forbidden", "该工具不允许当前成员使用。", 403),
          batch,
          index,
          "denied",
        );
      if (this.options.control?.accepts(prepared.descriptor.name)) {
        let result: ToolResult | undefined;
        try {
          await this.options.control.execute(
            batch.runId,
            invocation.id,
            prepared.descriptor.name,
            prepared.arguments,
            batch.signal,
            (data) => {
              // 协作管理状态和成功回执必须同事务提交；此动作不创建 Worker、不占业务锁或执行槽。
              const resultRef = `team:${invocation.id}`;
              const preview = createToolPreview(JSON.stringify(data), 8000, {
                reference: `read_tool_result resultId=${resultRef}`,
              });
              result = {
                callId: invocation.callId,
                ok: true,
                data,
                error: null,
                modelContent: preview.content,
                truncated: preview.truncated,
                resultRef,
              };
              invocation.status = "succeeded";
              invocation.result = result;
              invocation.endedAt = new Date().toISOString();
              this.options.store.put("invocations", invocation);
              this.options.store.put("attempts", {
                id: `control:${invocation.id}`,
                origin: "tool",
                invocationId: invocation.id,
                sessionId: context.sessionId,
                runId: batch.runId,
                status: "completed",
                workerId: "coordinator",
                acceptedAt: invocation.endedAt,
                startedAt: invocation.endedAt,
                endedAt: invocation.endedAt,
              });
            },
          );
        } catch (error) {
          if (this.options.control.pauseWait(error))
            throw new AppError("execution_paused", "等待成员消息。");
          if (error instanceof AppError && error.code === "execution_paused")
            throw error;
          return this.failed(item, safe(error), batch, index);
        }
        if (!result)
          throw new AppError("execution_storage", "协作动作没有提交回执。");
        await batch.onUpdate(index, "succeeded", result);
        return result;
      }
      invocation.status = "queued";
      this.options.store.put("invocations", invocation);
      await batch.onUpdate(index, "queued");
      const lockWait = this.observer?.span(observed, "tool.lock_wait");
      let release: () => void;
      try {
        release = await this.coordinator.acquire(
          batch.runId,
          prepared.lockKeys,
          batch.signal,
          {
            invocationId: invocation.id,
            toolName: invocation.toolName,
            onBlocked: (blockers) =>
              this.observer?.event(observed, "tool.lock_blocked", {
                "myagent.lock.blockers": JSON.stringify(blockers),
              }),
          },
        );
        lockWait?.end();
      } catch (error) {
        lockWait?.end(batch.signal.aborted ? "cancelled" : "failed");
        // 保留进程造成的本 Run 冲突是可处理的工具反馈，不能卡住整批或终结整个 Agent。
        if (
          error instanceof AppError &&
          ["process_resource_busy", "resource_busy"].includes(error.code)
        )
          return this.failed(item, error, batch, index);
        throw error;
      }
      const slotWait = this.observer?.span(observed, "tool.slot_wait");
      let leased = false;
      let dispatched = false;
      let recorded = false;
      try {
        await this.options.registry.revalidate(prepared, context);
        await this.authorize(item, batch, index);
        return await this.slots.use(batch.signal, async () => {
          slotWait?.end();
          // 全局并发槽也可能等待；进入真实派发前再次核验，不使用等待前的授权快照。
          await this.options.registry.revalidate(prepared, context);
          await this.authorize(item, batch, index);
          batch.signal.throwIfAborted();
          const attempt: ExecutionAttempt = {
            origin: "tool",
            id: this.options.id(),
            invocationId: invocation.id,
            sessionId: context.sessionId,
            runId: batch.runId,
            status: "dispatching",
            workerId: null,
            startedAt: new Date().toISOString(),
            endedAt: null,
          };
          this.options.store.transaction(() => {
            invocation.status = "running";
            this.options.store.put("invocations", invocation);
            this.options.store.put("attempts", attempt);
          });
          await batch.onUpdate(index, "running");
          const controller = new AbortController();
          const abort = () => controller.abort(batch.signal.reason);
          batch.signal.addEventListener("abort", abort, { once: true });
          if (batch.signal.aborted) abort();
          // 单命令进程与普通工具分别计时，不再截短为整项任务的剩余时间。
          const timeout =
            prepared.descriptor.name === "exec_command"
              ? Number(
                  prepared.arguments.timeoutMs ?? batch.limits.commandTimeoutMs,
                )
              : batch.limits.toolTimeoutMs;
          const timer = setTimeout(
            () =>
              controller.abort(
                new AppError("tool_timeout", "工具执行超时。", 504),
              ),
            timeout,
          );
          let receipt: ExecutionReceipt;
          try {
            const request: DispatchRequest = {
              attemptId: attempt.id,
              prepared,
              context,
              timeoutMs: timeout,
              authorizedResources: prepared.resources,
              onAccepted: async (workerId) => {
                // Worker 启动/沙箱探测也需要时间。发送动作前复查，变化时返回未执行错误。
                await this.options.registry.revalidate(prepared, context);
                if (
                  context.executionMode !== "full_access" &&
                  prepared.descriptor.name === "exec_command"
                ) {
                  const current = await this.options.commands?.assess(
                    prepared,
                    context,
                  );
                  if (
                    !current ||
                    current.binding !== invocation.command?.binding ||
                    current.decision === "deny" ||
                    (current.decision === "prompt" &&
                      !this.commandApproved(
                        invocation,
                        prepared,
                        current.binding,
                      ))
                  )
                    throw new AppError(
                      "command_policy_changed",
                      "命令权限在执行准备期间变化，本次操作未派发，请重新请求。",
                      409,
                    );
                }
                if (
                  context.executionMode !== "full_access" &&
                  evaluatePermissions({
                    workspace: context.workspace,
                    sessionId: context.sessionId,
                    invocationId: invocation.id,
                    fingerprint: prepared.fingerprint,
                    toolVersion: prepared.descriptor.version,
                    resources: prepared.resources,
                    grants: this.effectiveGrants(context.sessionId),
                    trustedReadPaths:
                      this.options.trustedReadPaths?.(context.runId) ?? [],
                  }).decision !== "allow"
                )
                  throw new AppError(
                    "permission_changed",
                    "资源授权已变化，本次操作未派发。",
                    403,
                  );
                controller.signal.throwIfAborted();
                attempt.workerId = workerId;
                attempt.status = "accepted";
                attempt.acceptedAt = new Date().toISOString();
                this.options.store.put("attempts", attempt);
              },
            };
            dispatched = true;
            const dispatchedSpan = this.observer?.span(
              { ...observed, attemptId: attempt.id },
              "tool.dispatch",
            );
            try {
              receipt = await this.options.gateway.dispatch(
                request,
                controller.signal,
              );
            } finally {
              dispatchedSpan?.end(
                controller.signal.aborted ? "cancelled" : "completed",
              );
            }
          } catch (cause) {
            const error = safe(cause);
            const knownBefore =
              [
                "sandbox_unavailable",
                "workspace_required",
                "process_not_found",
                "worker_initialized",
              ].includes(error.code) || attempt.status === "dispatching";
            const unknown =
              prepared.descriptor.effects !== "read" && !knownBefore;
            receipt = {
              attemptId: attempt.id,
              invocationId: invocation.id,
              outcome: unknown
                ? "unknown"
                : controller.signal.aborted
                  ? "cancelled"
                  : "failed",
              data: null,
              error: {
                code: unknown ? "result_unknown" : error.code,
                message: unknown
                  ? "操作可能已发生，但未获得可靠结果。必须先核对，不能直接重做。"
                  : error.message,
              },
              effectsPossible: unknown,
              completedAt: new Date().toISOString(),
            };
          } finally {
            clearTimeout(timer);
            batch.signal.removeEventListener("abort", abort);
          }
          const result = await this.saveReceipt(invocation, receipt, context);
          recorded = true;
          attempt.status =
            receipt.outcome === "unknown" ? "unknown" : "completed";
          attempt.endedAt = receipt.completedAt;
          this.options.store.put("attempts", attempt);
          if (
            receipt.data &&
            typeof receipt.data === "object" &&
            !Array.isArray(receipt.data) &&
            receipt.data.status === "running" &&
            typeof receipt.data.processId === "string" &&
            prepared.descriptor.name === "exec_command"
          ) {
            this.processLeases.set(receipt.data.processId, {
              runId: batch.runId,
              release: this.coordinator.retainProcess(
                batch.runId,
                receipt.data.processId,
                prepared.lockKeys,
                release,
              ),
            });
            leased = true;
            this.releaseFinishedProcesses(batch.runId);
          }
          if (receipt.outcome === "unknown") {
            await batch.onUpdate(index, "unknown", result);
            this.pause(batch.runId, "waiting_reconciliation");
          }
          batch.signal.throwIfAborted();
          await batch.onUpdate(
            index,
            result.ok ? "succeeded" : "failed",
            result,
          );
          return result;
        });
      } catch (error) {
        if (error instanceof AppError && error.code === "execution_paused")
          throw error;
        // 真实动作后保存失败不能伪装成“未执行”的普通工具错误；停止派发，保留 intent 供恢复核对。
        if (dispatched && !recorded) {
          await this.options.gateway.closeRun(batch.runId);
          const uncertain = invocation.effects !== "read";
          invocation.status = uncertain ? "unknown" : "failed";
          invocation.result = {
            callId: invocation.callId,
            ok: false,
            data: null,
            error: {
              code: "execution_storage",
              message: "动作已派发但完整回执未保存，请核对执行记录。",
            },
            modelContent: JSON.stringify({
              outcome: uncertain ? "unknown" : "failed",
              resultStorageFailed: true,
            }),
            truncated: false,
            outcome: uncertain ? "unknown" : "failed",
            effectsPossible: uncertain,
          };
          // 结果文件写入失败时尽可能保存最小隔离事实；SQLite 本身失效则由启动时的 intent 恢复。
          try {
            this.options.store.put("invocations", invocation);
          } catch {
            /* 不覆盖最后可靠的执行意图。 */
          }
          throw new AppError(
            "execution_storage",
            "保存执行结果失败，已停止后续动作，需要核对回执。",
            500,
          );
        }
        batch.signal.throwIfAborted();
        return this.failed(item, safe(error), batch, index);
      } finally {
        slotWait?.end(batch.signal.aborted ? "cancelled" : "completed");
        if (!leased) release();
      }
    } finally {
      const data = invocation.result?.data;
      toolSpan?.end(invocation.status, {
        "myagent.call.id": invocation.callId,
        ...(invocation.result?.resultRef
          ? { "myagent.result.ref": invocation.result.resultRef }
          : {}),
        ...(invocation.result?.error
          ? {
              "myagent.error.code": invocation.result.error.code,
              "myagent.error.message": invocation.result.error.message,
            }
          : {}),
        ...(data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        typeof data.agentId === "string"
          ? { "myagent.target.agent": data.agentId }
          : {}),
        ...(data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        typeof data.messageId === "string"
          ? { "myagent.message.id": data.messageId }
          : {}),
      });
    }
  }
  private async saveReceipt(
    invocation: ToolInvocation,
    receipt: ExecutionReceipt,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const value: JsonValue = {
      outcome: receipt.outcome,
      data: receipt.data,
      error: receipt.error ? { ...receipt.error } : null,
      effectsPossible: receipt.effectsPossible,
    };
    const saved = await this.options.results.save(context, value);
    const limit =
      this.options.store.get("checkpoints", context.runId)?.limits
        .toolResultCharacters ?? EXECUTION_LIMITS.resultCharacters;
    let preview: { content: string; truncated: boolean };
    try {
      preview = previewSavedResult(value, limit, saved.reference.id);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "context_limit")
        throw error;
      // 极小预算不能容纳状态/引用时先保存真实回执；上下文准备会暂停，不能误报动作结果未知。
      preview = { content: "", truncated: true };
    }
    const modelContent = preview.content;
    const truncated = preview.truncated;
    const visibleData = modelResultValue(receipt.data, saved.reference.id);
    const result: ToolResult = {
      callId: invocation.callId,
      ok: receipt.outcome === "succeeded",
      data: visibleData,
      error: receipt.error,
      outcome: receipt.outcome,
      effectsPossible: receipt.effectsPossible,
      resultRef: saved.reference.id,
      modelContent,
      truncated,
    };
    // 大结果正文不再塞进 Step/SSE；模型与 UI 均持有预览和受会话约束的引用。
    if (truncated)
      result.data = { resultRef: saved.reference.id, preview: modelContent };
    invocation.status = receipt.outcome;
    invocation.result = result;
    invocation.endedAt = receipt.completedAt;
    this.options.store.transaction(() => {
      this.options.commitResult?.(invocation, result);
      this.options.store.put("invocations", invocation);
    });
    return result;
  }
  private async failed(
    item: BatchItem,
    error: AppError,
    batch: ToolBatchOptions,
    index: number,
    status: "failed" | "denied" = "failed",
  ): Promise<ToolResult> {
    const result: ToolResult = {
      callId: item.call.id,
      ok: false,
      data: null,
      error: { code: error.code, message: error.message },
      modelContent: JSON.stringify({
        error: { code: error.code, message: error.message },
        executed: false,
      }),
      truncated: false,
      outcome: status,
      effectsPossible: false,
    };
    item.invocation.status = status;
    item.invocation.result = result;
    item.invocation.endedAt = new Date().toISOString();
    this.options.store.put("invocations", item.invocation);
    await batch.onUpdate(index, "failed", result);
    return result;
  }
  private pause(
    runId: string,
    status: "waiting_approval" | "waiting_reconciliation",
  ): never {
    this.options.store.setRunStatus(runId, status);
    throw new AppError(
      "execution_paused",
      status === "waiting_approval" ? "等待用户批准。" : "等待核对执行结果。",
    );
  }
  /** 命令和资源共用一次审批，但两者的授权来源独立；资源 allow 不能满足命令 prompt。 */
  private commandApproved(
    invocation: ToolInvocation,
    prepared: PreparedTool,
    binding: string,
  ): boolean {
    const approval = this.options.store
      .list("approvals", { runId: invocation.runId })
      .findLast((value) => value.invocationId === invocation.id);
    return Boolean(
      approval?.status === "approved" &&
        approval.fingerprint === prepared.fingerprint &&
        approval.toolVersion === prepared.descriptor.version &&
        approval.command?.binding === binding &&
        Date.parse(approval.expiresAt) > Date.now() &&
        !this.options.store.get("grants", approval.id)?.revokedAt &&
        this.options.store.get("grants", approval.id),
    );
  }

  /** 审批前及各等待边界重读当前规则；不把旧资源 grant 当作命令授权。 */
  /** 只继承主会话的 session 资源授权；一次性批准仍绑定成员本次调用，撤销时即时失效。 */
  private effectiveGrants(sessionId: string): PermissionGrant[] {
    const parent = this.options.grantSession?.(sessionId) ?? sessionId;
    return this.options.store
      .list("grants")
      .map((grant) =>
        grant.scope === "session" && grant.sessionId === parent
          ? { ...grant, sessionId }
          : grant,
      );
  }
  private async authorize(
    item: BatchItem,
    batch: ToolBatchOptions,
    index: number,
  ): Promise<void> {
    const { prepared, invocation, context } = item;
    const permission = this.observer?.span(
      {
        runId: batch.runId,
        sessionId: context.sessionId,
        invocationId: invocation.id,
      },
      "tool.permission",
    );
    let outcome = "allowed";
    try {
      if (!prepared) throw new AppError("tool_failed", "工具未准备完成。");
      // 完全访问跳过命令/资源审批；不生成 grant，不读取规则作隐式限制。
      // 参数、路径身份、工具版本、未知结果隔离和执行生命周期仍由外层检查。
      if (context.executionMode === "full_access") {
        outcome = "full_access";
        return;
      }
      const grants = this.effectiveGrants(context.sessionId);
      const resource = evaluatePermissions({
        workspace: context.workspace,
        sessionId: context.sessionId,
        invocationId: invocation.id,
        fingerprint: prepared.fingerprint,
        toolVersion: prepared.descriptor.version,
        resources: prepared.resources,
        grants,
        trustedReadPaths: this.options.trustedReadPaths?.(context.runId) ?? [],
      });
      if (prepared.descriptor.name === "exec_command") {
        if (!this.options.commands)
          throw new AppError(
            "command_policy_unavailable",
            "命令权限服务未装配，已拒绝执行。",
            503,
          );
        invocation.command = await this.options.commands.assess(
          prepared,
          context,
        );
        this.options.store.put("invocations", invocation);
      }
      const command = invocation.command;
      if (resource.decision === "deny" || command?.decision === "deny")
        throw new AppError(
          "permission_denied",
          command?.decision === "deny"
            ? command.reasons.join("；")
            : "该资源的访问已被拒绝。",
          403,
        );
      const old = this.options.store
        .list("approvals", { runId: batch.runId })
        .findLast((approval) => approval.invocationId === invocation.id);
      const matches =
        old?.fingerprint === prepared.fingerprint &&
        old.toolVersion === prepared.descriptor.version &&
        (!command || old.command?.binding === command.binding);
      const approvedCommand = command
        ? this.commandApproved(invocation, prepared, command.binding)
        : false;
      if (
        resource.decision === "allow" &&
        (!command || command.decision === "allow" || approvedCommand)
      )
        return;
      if (matches && (old?.status === "denied" || old?.status === "expired"))
        throw new AppError("approval_denied", "用户未批准该操作。", 403);
      if (!matches || !old || ["approved", "cancelled"].includes(old.status)) {
        if (!context.workspace)
          throw new AppError("workspace_required", "审批需要先绑定工作区。");
        const now = new Date();
        this.options.store.transaction(() => {
          if (old?.status === "pending")
            this.options.store.put("approvals", {
              ...old,
              status: "cancelled",
              resolvedAt: now.toISOString(),
            });
          this.options.store.put("approvals", {
            id: this.options.id(),
            sessionId: context.sessionId,
            runId: batch.runId,
            workspaceId: context.workspace?.id ?? "",
            invocationId: invocation.id,
            toolName:
              prepared.descriptor.source.kind === "mcp"
                ? `${this.options.store.get("connections", prepared.descriptor.source.connectionId)?.name ?? "MCP"} / ${prepared.descriptor.source.originalName}`
                : item.call.name,
            toolVersion: prepared.descriptor.version,
            arguments: prepared.arguments,
            fingerprint: prepared.fingerprint,
            resources: resource.missing,
            ...(command ? { command } : {}),
            status: "pending",
            createdAt: now.toISOString(),
            expiresAt: new Date(
              now.getTime() + EXECUTION_LIMITS.approvalTimeoutMs,
            ).toISOString(),
            resolvedAt: null,
          });
          invocation.status = "waiting_approval";
          this.options.store.put("invocations", invocation);
        });
      } else {
        invocation.status = "waiting_approval";
        this.options.store.put("invocations", invocation);
      }
      await batch.onUpdate(index, "waiting_approval");
      outcome = "waiting_approval";
      this.pause(batch.runId, "waiting_approval");
    } catch (error) {
      if (outcome !== "waiting_approval") outcome = "denied";
      throw error;
    } finally {
      permission?.end(outcome);
    }
  }
  decide(id: string, input: ApprovalDecision): ApprovalRequest {
    return this.options.store.transaction(() => {
      const approval = this.options.store.get("approvals", id);
      if (!approval) throw new AppError("not_found", "批准请求不存在。", 404);
      if (approval.command && input.scope !== "once")
        throw new AppError(
          "command_scope",
          "命令审批只允许本次调用；长期放行请在命令权限设置中添加规则。",
          400,
        );
      if (approval.status !== "pending") {
        if (
          approval.decision &&
          (approval.decision.requestId !== input.requestId ||
            approval.decision.decision !== input.decision ||
            approval.decision.scope !== input.scope)
        )
          throw new AppError(
            "decision_conflict",
            "这次审批已经处理，请刷新后查看结果。",
            409,
          );
        return approval;
      }
      if (Date.now() > Date.parse(approval.expiresAt)) {
        approval.status = "expired";
        this.options.store.put("approvals", approval);
        return approval;
      }
      const grant: PermissionGrant = {
        id: approval.id,
        workspaceId: approval.workspaceId,
        sessionId:
          input.scope === "workspace"
            ? null
            : input.scope === "session"
              ? (this.options.grantSession?.(approval.sessionId) ??
                approval.sessionId)
              : approval.sessionId,
        scope: input.scope,
        decision: input.decision,
        resources: approval.resources,
        fingerprint: input.scope === "once" ? approval.fingerprint : null,
        invocationId: input.scope === "once" ? approval.invocationId : null,
        createdAt: new Date().toISOString(),
        revokedAt: null,
        ...(approval.toolVersion ? { toolVersion: approval.toolVersion } : {}),
      };
      this.options.store.put("grants", grant);
      approval.decision = input;
      approval.status = input.decision === "allow" ? "approved" : "denied";
      approval.resolvedAt = new Date().toISOString();
      this.observer?.interval?.(
        {
          runId: approval.runId,
          sessionId: approval.sessionId,
          invocationId: approval.invocationId,
        },
        "approval.wait",
        approval.createdAt,
        approval.resolvedAt,
        approval.status,
      );
      this.options.store.put("approvals", approval);
      return approval;
    });
  }
  async revokeGrant(id: string): Promise<void> {
    const grant = this.options.store.get("grants", id);
    if (!grant) throw new AppError("not_found", "授权不存在。", 404);
    grant.revokedAt = new Date().toISOString();
    this.options.store.put("grants", grant);
    await Promise.all([
      this.options.gateway.revoke(grant.workspaceId),
      this.options.revokeExternal?.(grant.workspaceId),
    ]);
  }
  resolveUnknown(
    id: string,
    resolution: NonNullable<ToolInvocation["resolution"]>,
  ): ToolInvocation | ExecutionConcern {
    const concern = this.options.store.get("concerns", id);
    if (concern) {
      concern.resolution = resolution;
      this.options.store.put("concerns", concern);
      return concern;
    }
    return this.options.store.resolveInvocation(id, resolution);
  }
  /** 隔离按真实资源匹配，换调用 ID、会话或 MCP 工具名不能绕过未知结果。 */
  concerns(workspaceId?: string): ExecutionConcern[] {
    const values: ExecutionConcern[] = [
      ...this.options.store.list("concerns"),
      ...this.options.store
        .list("invocations")
        .filter((item) => item.status === "unknown" && !item.resolution)
        .map((item) => ({
          id: item.id,
          workspaceId: this.workspace(item.sessionId)?.id ?? "",
          sourceSessionId: item.sessionId,
          toolName: item.toolName,
          source: item.source,
          resources: item.resources,
          createdAt: item.createdAt,
        })),
    ];
    return values.filter(
      (item) =>
        !item.resolution && (!workspaceId || item.workspaceId === workspaceId),
    );
  }
  /** 会话删除不能抹掉尚未核对的外部事实；最小隔离资料独立于会话级联关系。 */
  archiveConcerns(sessionId: string): void {
    for (const concern of this.concerns().filter(
      (item) => item.sourceSessionId === sessionId,
    ))
      this.options.store.put("concerns", concern);
  }
  expireApprovals(): void {
    for (const approval of this.options.store.list("approvals"))
      if (
        approval.status === "pending" &&
        Date.parse(approval.expiresAt) <= Date.now()
      ) {
        if (!this.options.chat.snapshot(approval.sessionId).activeRun) continue;
        approval.status = "expired";
        approval.resolvedAt = new Date().toISOString();
        this.observer?.interval?.(
          {
            runId: approval.runId,
            sessionId: approval.sessionId,
            invocationId: approval.invocationId,
          },
          "approval.wait",
          approval.createdAt,
          approval.resolvedAt,
          approval.status,
        );
        this.options.store.put("approvals", approval);
      }
  }
  cancelApprovals(runId: string): void {
    for (const approval of this.options.store.list("approvals", { runId }))
      if (approval.status === "pending") {
        approval.status = "cancelled";
        approval.resolvedAt = new Date().toISOString();
        this.observer?.interval?.(
          {
            runId: approval.runId,
            sessionId: approval.sessionId,
            invocationId: approval.invocationId,
          },
          "approval.wait",
          approval.createdAt,
          approval.resolvedAt,
          approval.status,
        );
        this.options.store.put("approvals", approval);
      }
  }
  hasSideEffectsForQuestion(sessionId: string, questionId: string): boolean {
    const runIds = new Set(
      (this.options.chat.snapshot(sessionId).steps ?? [])
        .filter(
          (step) =>
            this.options.chat.getRun(step.runId).userMessageId === questionId,
        )
        .map((step) => step.runId),
    );
    return [...runIds].some((id) => this.hasSideEffects(id));
  }
  hasSideEffects(runId: string): boolean {
    return this.options.store
      .list("invocations", { runId })
      .some((item) => item.effects !== "read" && item.result?.effectsPossible);
  }
  effectsContext(sessionId: string): string {
    const index = this.options.store.contextFacts(sessionId);
    if (!index.effects && !index.unresolved && !index.activeProcesses)
      return "";
    return `执行事实索引（不代表授权；重跑不代表旧副作用撤销；明细可用 read_conversation_history，includeSuperseded=true 查阅）：\n${JSON.stringify(index)}`;
  }

  private releaseFinishedProcesses(runId: string): void {
    for (const process of this.options.gateway.processes(runId))
      if (process.status !== "running" && process.status !== "unknown") {
        const lease = this.processLeases.get(process.id);
        lease?.release();
        this.processLeases.delete(process.id);
      }
  }
  processChanged(runId: string): void {
    this.releaseFinishedProcesses(runId);
  }
  /** 命令退出状态未知必须进入调用事实，不能只让 UI 持有一个无法处理的清理状态。 */
  recordUncertainProcess(process: ProcessSession): void {
    const invocation = this.options.store.get(
      "invocations",
      process.invocationId,
    );
    if (!invocation || invocation.status === "unknown") return;
    invocation.status = "unknown";
    invocation.result = {
      callId: invocation.callId,
      ok: false,
      data: { processId: process.id, outputRef: process.outputRef },
      error: {
        code: "process_unknown",
        message: "无法确认命令进程状态，请核对后继续。",
      },
      modelContent: JSON.stringify({
        outcome: "unknown",
        processId: process.id,
      }),
      truncated: false,
      outcome: "unknown",
      effectsPossible: true,
    };
    this.options.store.put("invocations", invocation);
  }
  async finish(runId: string): Promise<boolean> {
    const { confirmed } = await this.options.gateway.closeRun(runId);
    const invocations = this.options.store.list("invocations", { runId });
    const hookConcerns = this.options.store
      .list("concerns")
      .filter(
        (c) => this.options.hooks?.store.get("events", c.id)?.runId === runId,
      );
    const unresolvedHook = hookConcerns.some((c) => !c.resolution);
    // 核对保持原 unknown；工具与 Hook 进程使用同一真实执行身份，不伪造工具调用。
    const resolved = (id: string) =>
      invocations.some((i) => i.id === id && i.resolution) ||
      hookConcerns.some((c) => c.id === id && c.resolution);
    const acknowledged =
      !confirmed &&
      !unresolvedHook &&
      (invocations.some((i) => i.status === "unknown" && i.resolution) ||
        hookConcerns.some((c) => c.resolution)) &&
      invocations.every((i) => i.status !== "unknown" || i.resolution) &&
      this.options.gateway
        .processes(runId)
        .every(
          (p) =>
            p.status !== "running" &&
            (p.status !== "unknown" || resolved(p.invocationId)),
        );
    if (confirmed || acknowledged) {
      for (const [id, lease] of this.processLeases)
        if (lease.runId === runId) {
          lease.release();
          this.processLeases.delete(id);
        }
      this.executors.delete(runId);
      this.snapshots.delete(runId);
    }
    return !unresolvedHook && (confirmed || acknowledged);
  }
  /** 启动只核对已存在的回执，绝不重新派发工具或请求模型。 */
  async recover(): Promise<void> {
    for (const grant of this.options.store.list("grants"))
      if (grant.scope !== "workspace" && !grant.revokedAt) {
        grant.revokedAt = new Date().toISOString();
        this.options.store.put("grants", grant);
      }
    for (const checkpoint of this.options.store.list("checkpoints")) {
      const run = this.options.chat.getRun(checkpoint.runId);
      if (run.status !== "recoverable") continue;
      await this.options.gateway.recoverProcesses?.(
        this.options.store.list("processes", { runId: run.id }),
      );
      const invocations = this.options.store.list("invocations", {
        runId: run.id,
      });
      for (const invocation of invocations) {
        if (terminal(invocation) || invocation.status === "unknown") continue;
        const attempt = this.options.store
          .list("attempts", { runId: run.id })
          .findLast((record) => record.invocationId === invocation.id);
        if (!attempt) continue;
        const receipt = await this.options.gateway.reconcile(
          attempt.id,
          attempt.workerId,
        );
        const context: ExecutionContext = {
          runId: run.id,
          sessionId: run.sessionId,
          stepId: invocation.stepId,
          invocationId: invocation.id,
          workspace: this.workspace(run.sessionId),
        };
        if (receipt) {
          await this.saveReceipt(invocation, receipt, context);
          attempt.status =
            receipt.outcome === "unknown" ? "unknown" : "completed";
          attempt.endedAt = receipt.completedAt;
        } else {
          const unknown =
            invocation.effects !== "read" && attempt.status !== "dispatching";
          await this.saveReceipt(
            invocation,
            {
              attemptId: attempt.id,
              invocationId: invocation.id,
              outcome: unknown ? "unknown" : "failed",
              data: null,
              error: {
                code: unknown ? "result_unknown" : "interrupted",
                message: unknown
                  ? "重启后无法确认该操作的执行结果，需要核对。"
                  : "上次只读或尚未确认派发的调用中断，没有自动重试。",
              },
              effectsPossible: unknown,
              completedAt: new Date().toISOString(),
            },
            context,
          );
          attempt.status = unknown ? "unknown" : "completed";
          attempt.endedAt = new Date().toISOString();
        }
        this.options.store.put("attempts", attempt);
      }
      for (const process of this.options.store.list("processes", {
        runId: run.id,
      }))
        if (process.status === "unknown") {
          const invocation = this.options.store.get(
            "invocations",
            process.invocationId,
          );
          if (invocation && invocation.status !== "unknown")
            await this.saveReceipt(
              invocation,
              {
                attemptId: "recovery",
                invocationId: invocation.id,
                outcome: "unknown",
                data: { processId: process.id, outputRef: process.outputRef },
                error: {
                  code: "process_unknown",
                  message:
                    "重启后无法确认命令及其后代进程的状态，需要人工核对。",
                },
                effectsPossible: true,
                completedAt: new Date().toISOString(),
              },
              {
                runId: run.id,
                sessionId: run.sessionId,
                stepId: invocation.stepId,
                invocationId: invocation.id,
                workspace: this.workspace(run.sessionId),
              },
            );
        }
      if (
        this.options.store
          .list("invocations", { runId: run.id })
          .some(
            (invocation) =>
              invocation.status === "unknown" && !invocation.resolution,
          )
      )
        this.options.store.setRunStatus(run.id, "waiting_reconciliation");
    }
  }
}
