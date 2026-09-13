/**
 * Run 执行过程投影：展示已持久化的工具、结果和模型声明的计划，不生成或推进计划。
 * 只接收 SDK 的公开 Step，厂商续接数据从未发送到浏览器；失败候选与旧答案按 runId 隔离。
 */
import type { RunPlan, RunStep } from "@myagent/sdk";
import { Markdown } from "./Markdown.js";

const statuses = {
  pending: "待执行",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已停止",
  interrupted: "已中断",
};
export function RunProcess({ steps }: { steps: RunStep[] }) {
  const toolSteps = steps.filter((step) => step.tools.length > 0);
  if (!toolSteps.length) return null;
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
    <div className="run-process">
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
      <details
        className="execution-details"
        open={steps.some((s) => s.status === "model" || s.status === "tools")}
      >
        <summary>
          执行过程 · {toolSteps.reduce((sum, s) => sum + s.tools.length, 0)}{" "}
          次工具调用
        </summary>
        {toolSteps.map((step) => (
          <div className="execution-step" key={step.id}>
            {step.content && <Markdown content={step.content} />}
            {step.tools.map((tool) => (
              <details key={tool.id} className="tool-call">
                <summary>
                  <code>{tool.name}</code>
                  <span>{statuses[tool.status]}</span>
                </summary>
                <div>参数</div>
                <pre>{tool.arguments}</pre>
                {tool.result && (
                  <>
                    <div>
                      结果{tool.result.truncated ? "（回传模型时已截断）" : ""}
                    </div>
                    <pre>
                      {JSON.stringify(
                        tool.result.ok ? tool.result.data : tool.result.error,
                        null,
                        2,
                      )}
                    </pre>
                  </>
                )}
              </details>
            ))}
          </div>
        ))}
      </details>
      <small>重新生成可能再次调用工具。</small>
    </div>
  );
}
