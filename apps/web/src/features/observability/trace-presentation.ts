/**
 * 面向任务的 Trace 展示投影：Agent → Step → 上下文/模型/工具批次。
 * 分组不是新 Span，不改变持久父子关系；仅使用明确的 Run、Step、invocation 身份归组。
 * 无法关联的旧节点保持独立，禁止用时间邻近猜测归属；创建成员与成员执行以关联表达。
 */
import type { SpanRecord, TraceEventRecord, TraceRecord } from "@myagent/sdk";
import { isIssue } from "./trace-view.js";

const internal = new Set([
  "tool.validate",
  "tool.permission",
  "tool.dispatch",
  "tool.lock_wait",
  "tool.slot_wait",
  "model.queue",
]);
export const isViewGroup = (span: SpanRecord) =>
  span.attributes["myagent.view.group"] === true;
/** 低成本正常检查收进详情；未知、异常、正在等待和显著等待仍需能定位。 */
export function diagnosticOnly(span: SpanRecord, now = Date.now()) {
  if (!internal.has(span.name) || isIssue(span.outcome)) return false;
  if (/wait|queue/.test(span.name))
    return (
      (span.durationMs ??
        (span.outcome === "running" ? now - Date.parse(span.startedAt) : 0)) <
      1000
    );
  return true;
}
function group(
  id: string,
  parent: string | null,
  name: string,
  spans: SpanRecord[],
  trace: TraceRecord,
): SpanRecord {
  const first = spans.toSorted((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  )[0];
  const active = spans.some((s) => s.outcome === "running");
  const complete = spans.every((s) => s.endedAt !== null);
  const startedAt = first?.startedAt ?? trace.startedAt;
  const endedAt =
    complete && spans.length
      ? spans
          .map((s) => s.endedAt!)
          .sort()
          .at(-1)!
      : null;
  return {
    id,
    parentId: parent,
    name,
    traceId: trace.id,
    scope: first?.scope ?? {},
    startedAt,
    endedAt,
    durationMs: endedAt
      ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
      : null,
    outcome: active
      ? "running"
      : spans.some((s) => isIssue(s.outcome))
        ? "error"
        : complete
          ? "completed"
          : "unknown",
    attributes: { "myagent.view.group": true, count: spans.length },
    links: [],
  };
}
export function presentTrace(
  trace: TraceRecord,
  spans: SpanRecord[],
  _events: TraceEventRecord[] = [],
  diagnostics = false,
) {
  const copy = spans.map((span) => ({
    ...span,
    attributes: { ...span.attributes },
  }));
  const byId = new Map(copy.map((span) => [span.id, span]));
  const steps = new Map(
    copy
      .filter((s) => s.name === "agent.step" && s.scope.stepId)
      .map((s) => [`${s.traceId}:${s.scope.stepId}`, s]),
  );
  const tools = new Map(
    copy
      .filter((s) => s.name === "tool.execute" && s.scope.invocationId)
      .map((s) => [s.scope.invocationId!, s]),
  );
  const agents = copy.filter((s) => s.name === "agent.run");
  if (agents.length > 1) {
    const root = group(`task:${trace.id}`, null, "view.task", agents, trace);
    root.scope = trace.scope;
    root.outcome = trace.task?.status ?? trace.status;
    copy.push(root);
    const identities = new Map<string, SpanRecord[]>();
    for (const agent of agents) {
      const identity = agent.scope.agentId ?? "main";
      identities.set(identity, [...(identities.get(identity) ?? []), agent]);
    }
    for (const [identity, runs] of identities) {
      if (runs.length === 1) {
        runs[0]!.parentId = root.id;
        continue;
      }
      const branch = group(
        `agent:${trace.id}:${identity}`,
        root.id,
        "view.agent",
        runs,
        trace,
      );
      branch.scope = runs[0]!.scope;
      branch.outcome =
        runs.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)
          ?.outcome ?? "unknown";
      copy.push(branch);
      for (const run of runs) {
        run.parentId = branch.id;
        run.name = "view.segment";
      }
    }
  }
  for (const span of spans) {
    const item = byId.get(span.id)!;
    const parent = byId.get(span.parentId ?? "");
    const tool = span.scope.invocationId
      ? tools.get(span.scope.invocationId)
      : undefined;
    if (tool && item.id !== tool.id && item.name !== "agent.run")
      item.parentId = tool.id;
    else if (
      span.scope.stepId &&
      span.name !== "agent.step" &&
      (!parent || parent.name === "agent.run")
    ) {
      const step = steps.get(`${span.traceId}:${span.scope.stepId}`);
      if (step && step.scope.runId === span.scope.runId)
        item.parentId = step.id;
    }
  }
  for (const step of steps.values()) {
    const calls = copy.filter(
      (s) => s.name === "tool.execute" && s.parentId === step.id,
    );
    step.attributes["myagent.tool.count"] ??= calls.length;
    if (!calls.length) continue;
    const batch = group(
      `tools:${step.id}`,
      step.id,
      "view.tools",
      calls,
      trace,
    );
    batch.scope = step.scope;
    copy.push(batch);
    for (const call of calls) call.parentId = batch.id;
  }
  if (!diagnostics) {
    const legacy = new Map<string, SpanRecord[]>();
    for (const span of copy) {
      if (
        span.name === "context.prepare" &&
        !span.scope.stepId &&
        span.parentId
      )
        legacy.set(span.parentId, [...(legacy.get(span.parentId) ?? []), span]);
    }
    for (const [parent, records] of legacy) {
      if (records.length < 2) continue;
      const collection = group(
        `unassigned:${parent}`,
        parent,
        "view.unassigned",
        records,
        trace,
      );
      copy.push(collection);
      for (const record of records) record.parentId = collection.id;
    }
  }
  if (diagnostics) return copy;
  const hidden = new Set(
    copy.filter((s) => diagnosticOnly(s)).map((s) => s.id),
  );
  // 隐藏中间节点也不能让其异常后代消失；提升到最近仍展示的祖先。
  for (const item of copy) {
    const seen = new Set<string>();
    while (
      item.parentId &&
      hidden.has(item.parentId) &&
      !seen.has(item.parentId)
    ) {
      seen.add(item.parentId);
      item.parentId = byId.get(item.parentId)?.parentId ?? null;
    }
  }
  return copy.filter((s) => !hidden.has(s.id));
}
