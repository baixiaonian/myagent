import {
  AppError,
  type RegenerateInput,
  type Run,
  type RunAccepted,
  type RunInput,
} from "@myagent/contracts";
import { buildContext, runChat } from "@myagent/kernel";
import { type ChatStore, contextBeforeQuestion } from "@myagent/state";
import type { SettingsService } from "./settings.js";
export class ChatService {
  private closing = false;
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  constructor(
    readonly store: ChatStore,
    private readonly settings: SettingsService,
    private readonly timeoutMs = 120000,
  ) {}
  start(
    sessionId: string,
    input: RunInput | RegenerateInput,
    kind: "send" | "regenerate" = "send",
  ): RunAccepted {
    if (this.closing)
      throw new AppError("unavailable", "本地服务正在关闭。", 503);
    const content = "content" in input ? input.content.trim() : "";
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
    const history =
      kind === "regenerate" && lastUser
        ? contextBeforeQuestion(snapshot.messages, lastUser.id)
        : snapshot.messages;
    const context = buildContext(history, question, settings.systemPrompt);
    const run = this.store.beginRun({
      sessionId,
      expectedRevision: input.expectedRevision,
      requestId: input.requestId,
      fingerprint,
      kind,
      content: question,
      model: settings.model,
      contextTrimmed: context.trimmed,
    });
    const controller = new AbortController();
    // 先登记取消句柄，再从微任务开始实际模型请求。
    const done = Promise.resolve().then(async () => {
      let buffer = "";
      let persistenceError: unknown;
      const flush = () => {
        if (buffer) {
          this.store.appendDelta(run.id, buffer);
          buffer = "";
        }
      };
      const timer = setInterval(() => {
        try {
          flush();
        } catch (error) {
          persistenceError = error;
          controller.abort();
        }
      }, 250);
      try {
        const result = await runChat(
          model,
          context.messages,
          controller.signal,
          (text) => {
            buffer += text;
          },
          this.timeoutMs,
        );
        if (persistenceError) throw persistenceError;
        flush();
        this.store.finishRun(run.id, {
          status: "succeeded",
          ...result,
          error: null,
        });
      } catch (error) {
        try {
          flush();
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
  async cancel(runId: string): Promise<Run> {
    const run = this.store.getRun(runId);
    const active = this.active.get(runId);
    if (active) {
      active.controller.abort();
      await active.done;
    }
    return this.store.getRun(run.id);
  }
  async deleteSession(id: string): Promise<void> {
    const run = this.store.snapshot(id).activeRun;
    if (run) await this.cancel(run.id);
    this.store.deleteSession(id);
  }
  async close(): Promise<void> {
    this.closing = true;
    const runs = [...this.active.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.done));
  }
}
