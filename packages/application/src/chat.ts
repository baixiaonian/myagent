/**
 * Agent 用例协调器：连接设置快照、完整历史、Run 事务和统一自主循环。
 * 活动取消句柄只存在于本进程；历史与事件归 ChatStore，模型通信经 Kernel 的 ModelPort。
 * 增量先缓冲再持久化，终态立即提交；删除、停止和关闭共享同一套生命周期。
 */
import {
  AGENT_LIMITS,
  type AgentLimits,
  AppError,
  LIMITS,
  type RegenerateInput,
  type Run,
  type RunAccepted,
  type RunInput,
} from "@myagent/contracts";
import {
  defaultContextBuilder,
  runAgent,
  type ToolExecutor,
} from "@myagent/kernel";
import { type ChatStore, contextBeforeQuestion } from "@myagent/state";
import { connectionIdentity, executionHistory } from "./context.js";
import type { SettingsService } from "./settings.js";
export class ChatService {
  private closing = false;
  // 只登记本进程真正执行的 Run；数据库中的 running 可能是上次崩溃遗留，需启动恢复。
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  constructor(
    readonly store: ChatStore,
    private readonly settings: SettingsService,
    private readonly timeoutMs = 120000,
    private readonly tools: ToolExecutor = {
      definitions: [],
      execute: async () => null,
    },
    private readonly limits: Partial<AgentLimits> = {},
  ) {}
  // 返回已落库的 Run 和快照；实际模型请求在微任务中启动，因此 HTTP 不等待整段回答。
  // 同 requestId 先查历史：即使原运行已结束、设置已改变，也必须返回原提交结果。
  start(
    sessionId: string,
    input: RunInput | RegenerateInput,
    kind: "send" | "regenerate" = "send",
  ): RunAccepted {
    if (this.closing)
      throw new AppError("unavailable", "本地服务正在关闭。", 503);
    const content = "content" in input ? input.content.trim() : "";
    // 指纹包含操作、内容和提交时版本；禁止把同一幂等键用于不同请求。
    const fingerprint = JSON.stringify([kind, content, input.expectedRevision]);
    const previous = this.store.findRequest(sessionId, input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError(
          "idempotency_conflict",
          "请求标识已经用于另一条操作。",
          409,
        );
      return { run: previous, snapshot: this.store.snapshot(sessionId) };
    }
    const snapshot = this.store.snapshot(sessionId);
    // 此处读取配置并创建专属模型实例；随后修改设置不会影响该次运行持有的连接。
    const { model, settings } = this.settings.model();
    const question =
      kind === "send"
        ? content
        : snapshot.messages.findLast((message) => message.role === "user")
            ?.content;
    if (!question)
      throw new AppError("invalid_input", "没有可以重新生成的问题。");
    const lastUser = snapshot.messages.findLast(
      (message) => message.role === "user",
    );
    // 重新生成时截取原问题之前的历史，防止旧答案或原问题再次进入当前问题上下文。
    const history =
      kind === "regenerate" && lastUser
        ? contextBeforeQuestion(snapshot.messages, lastUser.id)
        : snapshot.messages;
    if (!question.trim() || question.length > LIMITS.inputCharacters)
      throw new AppError("invalid_input", "请输入 1–8000 字符的问题。");
    const identity = connectionIdentity(settings);
    const modelHistory = executionHistory(this.store, history, identity);
    const current = [{ role: "user" as const, content: question }];
    const limits = {
      ...AGENT_LIMITS,
      modelTimeoutMs: this.timeoutMs,
      ...this.limits,
    };
    const context = defaultContextBuilder.build({
      instructions: settings.systemPrompt,
      history: modelHistory,
      current,
      tools: this.tools.definitions,
      limits,
    });
    // 上下文校验成功后才建 Run；事务同时保存问题、候选回答和开始事件，避免半条会话。
    const run = this.store.beginRun({
      sessionId,
      expectedRevision: input.expectedRevision,
      requestId: input.requestId,
      fingerprint,
      kind,
      content: question,
      model: settings.model,
      apiProtocol: settings.apiProtocol,
      contextTrimmed: context.trimmed,
    });
    const controller = new AbortController();
    // 先登记取消句柄，再从微任务开始实际模型请求。
    const done = Promise.resolve().then(async () => {
      let buffer = "";
      let activeStepId = "";
      let persistenceError: unknown;
      // 仅在仓储写入成功后清空 buffer；落盘失败时保留缓冲并中断请求，不向 UI 发布假进度。
      const flush = () => {
        if (buffer) {
          if (!this.store.appendStepDelta(run.id, activeStepId, buffer))
            throw new AppError("interrupted", "运行已结束，不能继续追加内容。");
          buffer = "";
        }
      };
      // 合并小分片以控制 SQLite 写入频率；此节拍与 Server 轮询 SSE 的 250ms 相互独立。
      const timer = setInterval(() => {
        try {
          flush();
        } catch (error) {
          persistenceError = error;
          controller.abort();
        }
      }, 250);
      try {
        const result = await runAgent({
          runId: run.id,
          model,
          current,
          history: modelHistory,
          instructions: settings.systemPrompt,
          signal: controller.signal,
          tools: this.tools,
          limits,
          onEvent: (event) => {
            if (persistenceError) throw persistenceError;
            if (event.type === "step.delta") {
              activeStepId = event.stepId;
              buffer += event.delta;
            } else if (event.type === "context.trimmed")
              this.store.markContextTrimmed(run.id);
            else {
              // 模型和工具边界是提交屏障；先落最后一批文字，再保存包含完整响应的步骤。
              flush();
              activeStepId = event.step.id;
              const step =
                this.closing &&
                (event.step.status === "cancelled" ||
                  event.step.status === "failed")
                  ? {
                      ...event.step,
                      status: "interrupted" as const,
                      tools: event.step.tools.map((t) =>
                        t.status === "cancelled"
                          ? { ...t, status: "interrupted" as const }
                          : t,
                      ),
                    }
                  : event.step;
              if (
                !this.store.saveStep({
                  step,
                  identity,
                  continuation: event.continuation ?? null,
                })
              )
                throw new AppError("interrupted", "运行已结束，不能继续执行。");
            }
          },
        });
        // 定时写入失败可能触发模型取消；优先传播落盘故障，不能将它误报为用户主动停止。
        if (persistenceError) throw persistenceError;
        flush();
        // 先 flush 最后不足一个周期的文字，再提交成功终态；SSE 不会先看到成功、后看到尾字。
        this.store.finishRun(run.id, {
          status: "succeeded",
          ...result,
          error: null,
        });
      } catch (error) {
        try {
          flush();
          // 服务关闭与用户停止分开标记；未知异常转换为本地安全提示，不持久化外部原始异常。
          const safe = this.closing
            ? new AppError(
                "interrupted",
                "本地服务已退出，生成中断，可手动重试。",
              )
            : error instanceof AppError
              ? error
              : new AppError(
                  "internal_error",
                  "本地处理失败，请检查数据目录或稍后重试。",
                  500,
                );
          this.store.finishRun(run.id, {
            status:
              safe.code === "interrupted"
                ? "interrupted"
                : safe.code === "cancelled"
                  ? "cancelled"
                  : "failed",
            finishReason: null,
            usage: null,
            error: { code: safe.code, message: safe.message },
          });
        } catch {
          /* 磁盘不可写时不伪造完成；启动恢复会将 running 标为 interrupted。 */
        }
      } finally {
        clearInterval(timer);
        this.active.delete(run.id);
      }
    });
    this.active.set(run.id, { controller, done });
    return { run, snapshot: this.store.snapshot(sessionId) };
  }
  // 取消先传播信号，再等待缓冲与终态提交完毕；调用方得到可立即重新读取的一致状态。
  async cancel(runId: string): Promise<Run> {
    const run = this.store.getRun(runId);
    const active = this.active.get(runId);
    if (active) {
      active.controller.abort();
      await active.done;
    }
    return this.store.getRun(run.id);
  }
  // 先收拢执行，再级联删除会话；仓储还会拒绝迟到增量，防止外部不合作时恢复已删除数据。
  async deleteSession(id: string): Promise<void> {
    const run = this.store.snapshot(id).activeRun;
    if (run) await this.cancel(run.id);
    this.store.deleteSession(id);
  }
  // 退出后拒绝新请求，并并行等待全部活动运行完成中断提交；不启动恢复或重试模型。
  async close(): Promise<void> {
    this.closing = true;
    const runs = [...this.active.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.done));
  }
}
