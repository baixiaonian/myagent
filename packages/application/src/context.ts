/**
 * 应用层历史桥接：把持久记录交给纯上下文构建器，不由 SDK 或内核查询数据库。
 * 连接身份不包含密钥；跨模型/协议只携带最终问答，禁止把厂商续接字段送往另一连接。
 */
import { AppError, type Message, type ModelSettings } from "@myagent/contracts";
import type { ModelMessage } from "@myagent/kernel";
import type { ChatStore } from "@myagent/state";
export function connectionIdentity(settings: ModelSettings): string {
  return JSON.stringify([
    settings.apiProtocol,
    settings.baseUrl.replace(/\/$/, ""),
    settings.model,
  ]);
}
export function executionHistory(
  store: ChatStore,
  messages: readonly Message[],
  identity: string,
  augment?: (
    runId: string,
    messages: readonly ModelMessage[],
  ) => ModelMessage[],
): ModelMessage[][] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((question) => {
      const answer = messages.findLast(
        (m) =>
          m.replyToId === question.id &&
          m.role === "assistant" &&
          m.status === "completed",
      );
      if (!answer) return [];
      // 恢复后的成功 Run 可能保留中断的模型尝试；它们是审计记录，不进入配对对话链。
      const records = store
        .getSteps(answer.runId)
        .filter((record) => record.step.status === "completed");
      const round: ModelMessage[] = [
        { role: "user", content: question.content, sourceId: question.id },
      ];
      if (!records.length || records.some((r) => r.identity !== identity))
        return [
          [
            ...round,
            { role: "assistant", content: answer.content, sourceId: answer.id },
          ],
        ];
      for (const { step, continuation } of records) {
        if (step.status !== "completed" || step.tools.some((t) => !t.result))
          throw new AppError(
            "context_history",
            "历史执行记录不完整，无法继续该会话。",
            500,
          );
        round.push({
          role: "assistant",
          sourceId: step.id,
          content: step.content,
          ...(step.tools.length
            ? {
                toolCalls: step.tools.map(({ id, name, arguments: args }) => ({
                  id,
                  name,
                  arguments: args,
                })),
              }
            : {}),
          ...(continuation !== null ? { continuation } : {}),
        });
        for (const tool of step.tools) {
          if (!tool.result)
            throw new AppError("context_history", "历史工具结果缺失。", 500);
          round.push({
            role: "tool",
            sourceId: `${step.id}/tool/${tool.id}`,
            callId: tool.id,
            content: tool.result.modelContent,
            resultInfo: {
              resultRef: tool.result.resultRef ?? null,
              outcome:
                tool.result.outcome ??
                (tool.result.ok ? "succeeded" : "failed"),
              error: tool.result.error
                ? {
                    code: tool.result.error.code,
                    message: tool.result.error.message,
                  }
                : null,
            },
          });
        }
      }
      return [augment ? augment(answer.runId, round) : round];
    });
}
