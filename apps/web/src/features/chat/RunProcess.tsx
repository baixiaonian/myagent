/**
 * Run 执行过程投影：展示已持久化的工具、结果和模型声明的计划，不生成或推进计划。
 * 只接收 SDK 的公开 Step，厂商续接数据从未发送到浏览器；失败候选与旧答案按 runId 隔离。
 */
import type { ChatClient, RunPlan, RunStep } from "@myagent/sdk";
import { Check, ChevronRight, LoaderCircle, Terminal } from "lucide-react";
import { ResultViewer } from "../tools/ResultViewer.js";
import { Markdown } from "./Markdown.js";

const statuses = {
  pending: "待执行",
  running: "执行中",
  waiting_approval: "等待批准",
  queued: "等待资源",
  unknown: "结果未知",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已停止",
  interrupted: "已中断",
};
export function RunProcess({
  steps,
  client,
  sessionId,
  active = false,
}: {
  steps: RunStep[];
  client: ChatClient;
  sessionId: string;
  active?: boolean;
}) {
  const toolSteps = steps.filter((step) => step.tools.length > 0);
  if (!toolSteps.length) return null;
  const tools = toolSteps.flatMap((step) => step.tools);
  const issues = tools.filter((tool) =>
    ["failed", "unknown", "interrupted"].includes(tool.status),
  );
  // 计划来自已成功调用的结构化结果；最新声明优先，空计划不显示占位卡片。
  const planResult = toolSteps
    .flatMap((s) => s.tools)
    .findLast((t) => t.name === "update_plan" && t.result?.ok)?.result?.data;
  const plan =
    planResult &&
    typeof planResult === "object" &&
    "steps" in planResult &&
    Array.isArray(planResult.steps)
      ? (planResult as unknown as RunPlan)
      : null;
  const occurrences = new Map<string, number>();
  const planItems =
    plan?.steps.map((item) => {
      const occurrence = (occurrences.get(item.description) ?? 0) + 1;
      occurrences.set(item.description, occurrence);
      return { ...item, key: `${item.description}:${occurrence}` };
    }) ?? [];
  return (
    // 终态切换时只重建一次折叠容器；之后由原生 details 保留用户展开状态，SSE 不抢回控制权。
    <details
      className="run-process"
      key={active ? "active" : "finished"}
      open={active}
    >
      <summary className="run-process-summary">
        <ChevronRight size={14} className="disclosure-arrow" />
        {active ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <Check size={14} />
        )}
        <span>
          {active ? "执行中" : "执行记录"} · {tools.length} 次工具调用
        </span>
        <span className="process-meta">{toolSteps.length} 个步骤</span>
        {issues.length > 0 && (
          <span className="process-warning">{issues.length} 次异常记录</span>
        )}
      </summary>
      <div className="run-process-body">
        {plan && plan.steps.length > 0 && (
          <section className="run-plan" aria-label="任务计划">
            <strong>任务计划</strong>
            <ul>
              {planItems.map((item) => (
                <li key={item.key} data-status={item.status}>
                  <span>
                    {item.status === "completed"
                      ? "✓"
                      : item.status === "in_progress"
                        ? "→"
                        : "○"}
                  </span>
                  {item.description}
                </li>
              ))}
            </ul>
            {plan.explanation && <p>{plan.explanation}</p>}
            <small>由模型维护的工作清单</small>
          </section>
        )}
        {/* 中间说明与工具批次保持顺序，最终答案在此容器外；折叠不删除任何原始过程。 */}
        {toolSteps.map((step) => (
          <div className="execution-step" key={step.id}>
            {step.content && <Markdown content={step.content} />}
            <details className="tool-batch">
              <summary>
                <ChevronRight size={14} />
                <span>执行工具 {step.tools.length} 次</span>
                <span className="tool-batch-names">
                  {step.tools.map((tool) => tool.name).join("、")}
                </span>
                <span className="tool-batch-status">
                  {step.tools.every((tool) => tool.status === "succeeded")
                    ? "已完成"
                    : [
                        ...new Set(
                          step.tools
                            .filter((tool) => tool.status !== "succeeded")
                            .map((tool) => statuses[tool.status]),
                        ),
                      ].join(" · ")}
                </span>
              </summary>
              {step.tools.map((tool) => (
                <details key={tool.id} className="tool-call">
                  <summary>
                    <Terminal size={13} />
                    <code>{tool.name}</code>
                    <span data-status={tool.status}>
                      {statuses[tool.status]}
                    </span>
                  </summary>
                  <div>参数</div>
                  <pre>{tool.arguments}</pre>
                  {tool.result && (
                    <>
                      <div>
                        结果
                        {tool.result.truncated ? "（回传模型时已截断）" : ""}
                      </div>
                      <pre>
                        {JSON.stringify(
                          tool.result.ok ? tool.result.data : tool.result.error,
                          null,
                          2,
                        )}
                      </pre>
                      {tool.result.resultRef && (
                        <ResultViewer
                          client={client}
                          sessionId={sessionId}
                          resultId={tool.result.resultRef}
                        />
                      )}
                    </>
                  )}
                </details>
              ))}
            </details>
          </div>
        ))}
      </div>
    </details>
  );
}
