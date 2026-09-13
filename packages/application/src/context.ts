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
      const records = store.getSteps(answer.runId);
      const round: ModelMessage[] = [
        { role: "user", content: question.content },
      ];
      if (!records.length || records.some((r) => r.identity !== identity))
        return [[...round, { role: "assistant", content: answer.content }]];
      for (const { step, continuation } of records) {
        if (step.status !== "completed" || step.tools.some((t) => !t.result))
          throw new AppError(
            "context_history",
            "历史执行记录不完整，无法继续该会话。",
            500,
          );
        round.push({
          role: "assistant",
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
            callId: tool.id,
            content: tool.result.modelContent,
          });
        }
      }
      return [round];
    });
}
