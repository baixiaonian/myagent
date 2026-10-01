/**
 * 摘要任务执行器：无工具模型请求、预算内分块、草稿恢复与取消围栏。
 * 只产生完整摘要候选；正式启用由 ContextService 的检查点事务负责。
 */
import { randomUUID } from "node:crypto";
import { AppError } from "@myagent/contracts";
import {
  abortable,
  type ContextInput,
  type contextBudget,
  estimateTokens,
  type ModelEvent,
  type ModelMessage,
  type ModelPort,
  wholeCharacterEnd,
} from "@myagent/kernel";
import type {
  ContextRunRecord,
  ContextStore,
  ContextSummaryRecord,
} from "@myagent/state";
import {
  addUsage,
  type Block,
  hash,
  SUMMARY_INSTRUCTIONS,
  SUMMARY_VERSION,
  zero,
} from "./context-support.js";
export class ContextSummarizer {
  observer: import("@myagent/observability").ObserverPort | undefined;
  constructor(
    private readonly store: ContextStore,
    private readonly assertCurrent: (
      state: ContextRunRecord,
      signal: AbortSignal,
    ) => void,
  ) {}
  async summarize(
    state: ContextRunRecord,
    model: ModelPort,
    blocks: Block[],
    question: ModelMessage,
    budget: ReturnType<typeof contextBudget>,
    input: ContextInput,
    signal: AbortSignal,
  ): Promise<ContextSummaryRecord> {
    const span = this.observer?.span(
      {
        ...input.observation,
        runId: state.runId,
        sessionId: state.sessionId,
        purpose: "summary",
      },
      "context.compact",
    );
    let outcome = "succeeded";
    try {
      const sources = blocks.flatMap((b) => b.sources);
      // 私有 reasoning/加密 Item 不进入语义摘要；调用与结果使用可见正文、名称和参数。
      const texts = blocks.map((b) =>
        JSON.stringify(
          b.messages.map((m) => ({
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls,
            callId: m.callId,
          })),
        ),
      );
      const estimate = (m: ModelMessage[]) =>
        model.estimateInput?.(m, []) ??
        estimateTokens({ messages: m, tools: [] });
      const prompt = (draft: string, text: string): ModelMessage[] => [
        {
          role: "system",
          content: `${SUMMARY_INSTRUCTIONS}\n请用精简要点而非长篇报告。目标控制在约 ${Math.floor(budget.summary * 0.6)} 个中文字符或 ${Math.floor(budget.summary * 0.4)} 个英文单词；不复述日志与长段证据。保留继续执行的目标、约束、结论、未完成事项和查阅引用。期望正文不超过 ${budget.summary * 3} UTF-8 字节，优先写必要信息。`,
        },
        {
          role: "user",
          content: JSON.stringify({
            currentGoal: question.content,
            previousSummary: draft,
            records: text,
          }),
        },
      ];
      // 按实际摘要请求估算分块；即使单条消息很大也可分段，不切坏原始工具协议。
      const chunks: string[] = [];
      let pending = "";
      for (const text of texts) {
        let rest = text;
        while (rest) {
          let lo = 0,
            hi = rest.length;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (
              estimate(
                prompt(
                  "摘".repeat(budget.summaryMax),
                  pending + rest.slice(0, mid),
                ),
              ) <= budget.input &&
              (!state.legacyCharacterLimit ||
                JSON.stringify(
                  prompt(
                    "摘".repeat(budget.summaryMax),
                    pending + rest.slice(0, mid),
                  ),
                ).length <= state.legacyCharacterLimit)
            )
              lo = mid;
            else hi = mid - 1;
          }
          lo = wholeCharacterEnd(rest, lo);
          if (!lo) {
            if (pending) {
              chunks.push(pending);
              pending = "";
              continue;
            }
            throw new AppError(
              "context_summary_input",
              "当前问题和摘要指令已占满摘要预算。",
            );
          }
          pending += rest.slice(0, lo);
          rest = rest.slice(lo);
          if (rest) {
            chunks.push(pending);
            pending = "";
          }
        }
      }
      if (pending) chunks.push(pending);
      const jobId = `${state.runId}:${hash([SUMMARY_VERSION, state.identity, state.instructionsHash, sources, state.capacity, chunks])}`;
      const old = this.store.get("jobs", jobId);
      const job = old ?? {
        id: jobId,
        runId: state.runId,
        sessionId: state.sessionId,
        generation: state.generation,
        sources,
        status: "running" as const,
        draft: "",
        nextChunk: 0,
        usage: zero(),
        error: null,
        createdAt: new Date().toISOString(),
      };
      job.generation = state.generation;
      job.status = "running";
      job.error = null;
      state.view.status = "compacting";
      this.store.transaction(() => {
        this.store.put("jobs", job);
        this.store.put("runs", state);
      });
      try {
        for (let index = job.nextChunk; index < chunks.length; index++) {
          this.assertCurrent(state, signal);
          const request = prompt(job.draft, chunks[index] ?? "");
          if (estimate(request) > budget.input)
            throw new AppError(
              "context_summary_input",
              "摘要请求超过输入预算。",
            );
          state.view.compactionRequests++;
          this.store.put("runs", state);
          const controller = new AbortController();
          const cancel = () => controller.abort(signal.reason);
          signal.addEventListener("abort", cancel, { once: true });
          const timer = setTimeout(
            () =>
              controller.abort(
                new AppError(
                  "context_summary_timeout",
                  "整理上下文超时，请手动重试。",
                ),
              ),
            input.limits.modelTimeoutMs,
          );
          let terminal: Extract<ModelEvent, { type: "done" }> | undefined;
          let text = "";
          let produced = 0;
          let iterator: AsyncIterator<ModelEvent> | undefined;
          try {
            iterator = model
              .stream(request, controller.signal, [], {
                ...input.observation,
                ...(span?.id ? { parentSpanId: span.id } : {}),
                runId: job.runId,
                sessionId: job.sessionId,
                jobId: job.id,
                purpose: "summary",
                ...(span?.id ? { parentSpanId: span.id } : {}),
              })
              [Symbol.asyncIterator]();
            for (;;) {
              const part = await abortable(iterator.next(), controller.signal);
              if (part.done) break;
              if (terminal)
                throw new AppError(
                  "context_summary_protocol",
                  "摘要响应结束后仍有数据。",
                );
              const event = part.value;
              if (event.type === "text") {
                text += event.text;
                produced += event.text.length;
              }
              if (event.type === "output") produced += event.characters;
              // 目标附近继续收齐响应与 usage，不能刚超目标就取消付费请求。
              // 极端异常流仍受独立采集边界保护；此限制不是任务累计产出上限。
              if (estimateTokens(text) > Math.max(32768, budget.summaryMax * 4))
                throw new AppError(
                  "context_summary_size",
                  "摘要响应超过采集边界，未发布不完整摘要。",
                );
              if (event.type === "done") terminal = event;
            }
            if (
              !terminal ||
              !["stop", "completed"].includes(terminal.finishReason) ||
              terminal.response?.toolCalls.length ||
              !text.trim()
            )
              throw new AppError(
                "context_summary_invalid",
                "摘要未完整完成或没有有效正文。",
              );
            if (estimateTokens(text) > budget.summaryMax)
              throw new AppError(
                "context_summary_size",
                `完整摘要超过可用摘要空间（${budget.summaryMax} 个估算 token）；原上下文保持，已收到的用量仍记账。`,
              );
            if (
              estimateTokens(text) >=
              estimateTokens(job.draft) + estimateTokens(chunks[index] ?? "")
            )
              throw new AppError(
                "context_summary_no_reduction",
                "摘要未缩小输入，原有效摘要保持。",
              );
            this.assertCurrent(state, signal);
            job.draft = text;
            job.nextChunk = index + 1;
            job.usage = addUsage(job.usage, terminal.usage);
            state.view.compactionUsage = addUsage(
              state.view.compactionUsage,
              terminal.usage,
            );
          } catch (error) {
            // 完整响应即使未通过发布校验，也是真实付费调用，保留任务与上下文用量。
            job.usage = addUsage(job.usage, terminal?.usage ?? null);
            state.view.compactionUsage = addUsage(
              state.view.compactionUsage,
              terminal?.usage ?? null,
            );
            throw error;
          } finally {
            state.summaryOutputCharacters += produced;
            controller.abort();
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            void iterator?.return?.().catch(() => {});
          }
          this.store.transaction(() => {
            this.store.put("jobs", job);
            this.store.put("runs", state);
          });
        }
        this.assertCurrent(state, signal);
        const summary: ContextSummaryRecord = {
          id: randomUUID(),
          runId: state.runId,
          sessionId: state.sessionId,
          text: job.draft,
          sources,
          identity: state.identity,
          instructionsHash: state.instructionsHash,
          segment: blocks[0]?.segment ?? "history",
          createdAt: new Date().toISOString(),
          previewBased: true,
          templateVersion: SUMMARY_VERSION,
        };
        job.status = "completed";
        // 摘要先作为完整候选落库；只有 prepare 最后的事务才能切换实际请求检查点。
        this.store.transaction(() => {
          this.store.put("summaries", summary);
          this.store.put("jobs", job);
          this.store.put("runs", state);
        });
        return summary;
      } catch (error) {
        if (signal.aborted) {
          state.view.status = "interrupted";
          state.view.error = {
            code: "context_interrupted",
            message: "上下文整理已中断，原历史与有效摘要保留。",
          };
        }
        job.status = signal.aborted ? "interrupted" : "failed";
        job.error =
          error instanceof AppError ? error.message : "摘要请求失败。";
        // 失败记录也经过 Run 生存检查；已删除时不能补写孤儿记录。
        this.store.transaction(() => {
          this.store.put("jobs", job);
          this.store.put("runs", state);
        });
        throw error;
      }
    } catch (error) {
      outcome = signal.aborted ? "cancelled" : "failed";
      throw error;
    } finally {
      span?.end(outcome);
    }
  }
}
