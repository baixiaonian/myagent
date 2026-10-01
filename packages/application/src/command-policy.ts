/**
 * 命令权限用例：规则文件是事实源；确认准确版本、恢复落盘日志，并组合项目/用户规则。
 * 本服务不启动进程。评估和设置测试共用路径，避免页面显示与真正执行采用不同规则。
 */
import {
  AppError,
  type CommandAssessment,
  type CommandConfigConfirmation,
  type CommandConfigSave,
  type CommandConfigTarget,
  type CommandConfigView,
  type CommandRuleDocument,
} from "@myagent/contracts";
import {
  type CommandAnalyzerPort,
  type ExecutionContext,
  evaluateCommands,
  type PreparedTool,
  type WorkspacePort,
} from "@myagent/kernel";
import type {
  CommandConfigFilePort,
  CommandFileState,
  ExecutionStore,
} from "@myagent/state";

const empty = (): CommandRuleDocument => ({ schemaVersion: 1, rules: [] });
/** 严格检查规则文档，拒绝未知字段和空前缀；不把非法文件解释为空规则。 */
export function parseCommandRules(text: string): CommandRuleDocument {
  if (!text.trim()) return empty();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const position =
      error instanceof Error
        ? error.message.match(/position (\d+)|line (\d+) column (\d+)/)?.[0]
        : undefined;
    throw new AppError(
      "invalid_command_config",
      `命令规则 JSON 无效${position ? `（${position}）` : "，请检查括号、引号及逗号"}。`,
    );
  }
  const object = (v: unknown): v is Record<string, unknown> =>
    Boolean(v && typeof v === "object" && !Array.isArray(v));
  const invalid = () =>
    new AppError(
      "invalid_command_config",
      "规则需为 schemaVersion:1 和 rules 数组；每项包含唯一 id、非空 pattern 参数数组、allow/prompt/deny，以及可选 description。",
    );
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.rules) ||
    value.rules.length > 200 ||
    Object.keys(value).some((key) => !["schemaVersion", "rules"].includes(key))
  )
    throw invalid();
  const ids = new Set<string>();
  const rules = value.rules.map((rule) => {
    if (
      !object(rule) ||
      Object.keys(rule).some(
        (key) => !["id", "pattern", "decision", "description"].includes(key),
      ) ||
      typeof rule.id !== "string" ||
      !/^[\w.-]{1,80}$/.test(rule.id) ||
      ids.has(rule.id) ||
      !Array.isArray(rule.pattern) ||
      !rule.pattern.length ||
      rule.pattern.length > 100 ||
      rule.pattern.some(
        (arg) =>
          typeof arg !== "string" || arg.length > 4000 || arg.includes("\0"),
      ) ||
      !rule.pattern[0] ||
      !["allow", "prompt", "deny"].includes(String(rule.decision)) ||
      (rule.description !== undefined &&
        (typeof rule.description !== "string" ||
          rule.description.length > 1000))
    )
      throw invalid();
    ids.add(rule.id);
    return {
      id: rule.id,
      pattern: rule.pattern as string[],
      decision: rule.decision as "allow" | "prompt" | "deny",
      ...(typeof rule.description === "string"
        ? { description: rule.description }
        : {}),
    };
  });
  return { schemaVersion: 1, rules };
}
export class CommandPolicyService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: ExecutionStore,
    private readonly files: CommandConfigFilePort,
    private readonly analyzer: CommandAnalyzerPort,
    private readonly workspaces: WorkspacePort,
  ) {}
  /** 同进程的确认/保存/读取串行，避免读取线程清掉正在提交的日志。 */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(operation);
    this.tail = next;
    return next;
  }
  private hash(document: CommandRuleDocument): string {
    return this.files.digest(JSON.stringify(document));
  }
  private id(target: CommandConfigTarget): string {
    return target.scope === "user"
      ? "command:user"
      : `command:project:${target.workspaceId}`;
  }
  private async target(
    target: CommandConfigTarget,
  ): Promise<CommandConfigTarget> {
    if (target.scope === "user") {
      if (target.workspaceId)
        throw new AppError("invalid_target", "用户级规则不绑定项目。");
      return { scope: "user" };
    }
    const workspace = this.store.get("workspaces", target.workspaceId ?? "");
    if (!workspace) throw new AppError("workspace_required", "请先选择项目。");
    await this.workspaces.validate(workspace);
    return { scope: "project", workspaceId: workspace.id };
  }
  private async read(
    targetInput: CommandConfigTarget,
  ): Promise<CommandConfigView> {
    const target = await this.target(targetInput);
    const raw = await this.files.read(target);
    const id = this.id(target);
    let state = this.store.get("commandFiles", id);
    if (state?.staged) {
      // rename 已完成则恢复用户确认；未落盘或被再次外部编辑则保留原可信版本，绝不重写文件。
      if (raw.revision === this.files.digest(state.staged.text)) {
        const document = parseCommandRules(state.staged.text);
        state = { id, target, document, trustedHash: this.hash(document) };
      } else {
        const { staged: _staged, ...previous } = state;
        state = previous;
      }
      this.store.put("commandFiles", state);
    }
    if (!state) {
      state = {
        id,
        target,
        document: empty(),
        trustedHash: this.hash(empty()),
      };
      this.store.put("commandFiles", state);
    }
    let document: CommandRuleDocument | null = null;
    let error: string | null = null;
    try {
      document = parseCommandRules(raw.text);
    } catch (cause) {
      error = cause instanceof AppError ? cause.message : "无法读取命令规则。";
    }
    // 数据目录不对 Agent 开放，用户级外部编辑视为本机用户意图；项目文件仍须准确版本确认。
    if (
      document &&
      target.scope === "user" &&
      this.hash(document) !== state.trustedHash
    ) {
      state = { id, target, document, trustedHash: this.hash(document) };
      this.store.put("commandFiles", state);
    }
    return {
      target,
      ...raw,
      document,
      lastValid: state.document,
      pending: !document || this.hash(document) !== state.trustedHash,
      error,
    };
  }
  view(target: CommandConfigTarget): Promise<CommandConfigView> {
    return this.serial(() => this.read(target));
  }
  save(input: CommandConfigSave): Promise<CommandConfigView> {
    return this.serial(async () => {
      const view = await this.read(input);
      if (view.revision !== input.expectedRevision)
        throw new AppError(
          "revision_conflict",
          "命令规则已改变，请刷新后重新保存。",
          409,
        );
      if (!input.text.trim())
        throw new AppError(
          "invalid_command_config",
          "请使用完整 JSON 保存；清空规则请设置 rules:[]。",
        );
      const document = parseCommandRules(input.text);
      const state = this.store.get(
        "commandFiles",
        this.id(view.target),
      ) as CommandFileState;
      this.store.put("commandFiles", {
        ...state,
        staged: { text: input.text, previousRevision: view.revision },
      });
      // write 在 rename 后抛错时保留日志，由下一次读取确认实际磁盘状态，不能丢弃已保存的用户意图。
      await this.files.write(view.target, input.text, view.revision);
      this.store.put("commandFiles", {
        id: state.id,
        target: view.target,
        document,
        trustedHash: this.hash(document),
      });
      return this.read(view.target);
    });
  }
  confirm(input: CommandConfigConfirmation): Promise<CommandConfigView> {
    return this.serial(async () => {
      const view = await this.read(input);
      if (view.revision !== input.expectedRevision)
        throw new AppError(
          "revision_conflict",
          "规则已再次变化，请查看新版本后确认。",
          409,
        );
      if (!view.document)
        throw new AppError(
          "invalid_command_config",
          view.error ?? "无效的命令规则。",
        );
      this.store.put("commandFiles", {
        id: this.id(view.target),
        target: view.target,
        document: view.document,
        trustedHash: this.hash(view.document),
      });
      return this.read(view.target);
    });
  }
  async assess(
    prepared: PreparedTool,
    context: ExecutionContext,
  ): Promise<CommandAssessment> {
    if (!context.workspace)
      throw new AppError("workspace_required", "命令需要工作区。");
    await this.workspaces.validate(context.workspace);
    const command = String(prepared.arguments.command);
    const cwd = String(prepared.arguments.cwd ?? context.workspace.path);
    const analysis = await this.analyzer.analyze(command, cwd);
    const views = await this.serial(async () => [
      await this.read({ scope: "user" }),
      await this.read({
        scope: "project",
        workspaceId: context.workspace?.id ?? "",
      }),
    ]);
    const blocked = views.find((view) => view.error || view.pending);
    const policyRevision = this.files.digest(
      JSON.stringify(
        views.map((view) => [
          view.target,
          view.document ? this.hash(view.document) : view.revision,
          view.pending,
          view.error,
        ]),
      ),
    );
    const result = blocked
      ? {
          decision: "deny" as const,
          reasons: [
            blocked.error ??
              "项目命令规则发生变更，请在命令权限设置中确认准确版本。",
          ],
          matches: [],
        }
      : evaluateCommands(
          analysis,
          views.map((view) => ({
            scope: view.target.scope,
            rules: view.document?.rules ?? [],
          })),
        );
    const binding = this.files.digest(
      JSON.stringify({
        policyRevision,
        analysis,
        command,
        cwd,
        fingerprint: prepared.fingerprint,
        version: prepared.descriptor.version,
        workspace: context.workspace.identity,
        invocation: context.invocationId,
        session: context.sessionId,
        run: context.runId,
      }),
    );
    return { command, cwd, ...result, analysis, policyRevision, binding };
  }
  /** 启动时只修复配置日志，不产生工具动作或重新派发。 */
  async initialize(): Promise<void> {
    for (const state of this.store.list("commandFiles")) {
      if (
        state.target.scope === "project" &&
        !this.store.get("workspaces", state.target.workspaceId ?? "")
      )
        continue;
      try {
        await this.view(state.target);
      } catch {
        /* 无法访问的项目在使用时拒绝，不阻止其他项目启动。 */
      }
    }
  }
}
