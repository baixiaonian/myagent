/**
 * 观测 Web 的纯展示模型：组织真实 Span 父子关系、筛选路径和统一时间坐标。
 * 不推测缺失的调用关系，不把并行耗时相加；分页缺失父节点时暂列根节点。
 */
import type { SpanRecord, TraceRecord } from "@myagent/sdk";

export const traceHref = (id: string, spanId?: string) =>
  `/traces/${encodeURIComponent(id)}${spanId ? `?span=${encodeURIComponent(spanId)}` : ""}`;

export const duration = (ms: number | null | undefined) =>
  ms == null || !Number.isFinite(ms)
    ? "未知"
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : ms < 60000
        ? `${(ms / 1000).toFixed(2)} s`
        : `${(ms / 60000).toFixed(2)} min`;

export const statusText = (status: string) =>
  ({
    running: "运行中",
    succeeded: "已完成",
    cancelled: "已停止",
    failed: "失败",
    interrupted: "已中断",
    waiting_approval: "等待审批",
    waiting_agents: "等待成员",
    waiting_context: "等待上下文",
    recoverable: "待恢复",
    cleaning: "收尾中",
    ok: "成功",
    error: "失败",
    unknown: "未知",
    pending: "待执行",
    completed: "已完成",
    exited: "已退出",
    full_access: "完全访问",
    allowed: "已允许",
    denied: "已拒绝",
  })[status] ?? status;

export const spanTitle = (name: string) =>
  ({
    "agent.run": "Agent 运行",
    "agent.step": "Step",
    "view.task": "完整任务",
    "view.tools": "工具调用",
    "view.unassigned": "旧上下文准备（未关联 Step）",
    "process.lifecycle": "进程运行",
    "mcp.call": "MCP 调用",
    "mcp.handshake": "MCP 连接",
    "mcp.discovery": "MCP 工具发现",
    "gen_ai.request": "模型请求",
    "model.queue": "模型排队",
    "context.prepare": "准备上下文",
    "context.compact": "压缩上下文",
    "tool.execute": "工具调用",
    "tool.validate": "参数校验",
    "tool.permission": "权限检查",
    "tool.dispatch": "实际派发",
    "tool.lock_wait": "资源锁等待",
    "tool.slot_wait": "执行槽等待",
    "approval.wait": "审批记录",
    "run.waiting_approval": "等待用户审批",
    "run.waiting_agents": "等待成员",
    "team.message.queued": "协作消息入队",
    "team.message.included": "协作消息接收",
  })[name] ?? name;

export function spanLabel(span: SpanRecord) {
  if (span.name === "agent.step" && typeof span.attributes.index === "number")
    return `Step ${span.attributes.index} · ${Number(span.attributes["myagent.tool.count"]) > 0 ? `${span.attributes["myagent.tool.count"]} 个工具` : span.outcome === "running" ? "执行中" : span.attributes["myagent.finish_reason"] === "stop" ? "输出回答" : "模型步骤"}`;
  if (span.name === "view.tools")
    return `工具调用 · ${span.attributes.count} 个`;
  if (span.name === "view.segment")
    return `执行段 · ${new Date(span.startedAt).toLocaleTimeString()}`;
  if (span.name === "agent.run" || span.name === "view.agent")
    return (
      span.scope.agentName ??
      (span.scope.agentId && span.scope.agentId !== "main"
        ? `成员 ${span.scope.agentId.slice(0, 8)}`
        : "主 Agent")
    );
  if (span.name.startsWith("team.message."))
    return `${spanTitle(span.name)} · ${span.attributes.kind ?? "回复"} · ${span.attributes.from ?? ""} → ${span.attributes.to ?? ""}`;
  const detail =
    span.attributes["gen_ai.tool.name"] ??
    span.attributes["gen_ai.request.model"];
  return detail ? `${spanTitle(span.name)} · ${detail}` : spanTitle(span.name);
}
export const categories = {
  agent: "Agent",
  model: "模型",
  tool: "工具",
  context: "上下文",
  wait: "等待",
  other: "其他",
};
export type SpanCategory = keyof typeof categories;
export function spanCategory(span: SpanRecord): SpanCategory {
  if (span.name === "view.tools") return "tool";
  if (span.name === "view.unassigned") return "context";
  if (["view.task", "view.agent", "view.segment"].includes(span.name))
    return "agent";
  if (/wait|queue/.test(span.name)) return "wait";
  if (span.name.startsWith("gen_ai")) return "model";
  if (/^(tool|mcp|hook|process)\./.test(span.name)) return "tool";
  if (span.name.startsWith("context")) return "context";
  return span.name.startsWith("agent") ? "agent" : "other";
}
export const isIssue = (status: string) =>
  ["failed", "error", "interrupted", "unknown", "denied"].includes(status);

export interface TraceRow {
  span: SpanRecord;
  depth: number;
  parent: string | null;
  hasChildren: boolean;
  match: boolean;
}

/** 先构建树再过滤，保留命中项的祖先；损坏数据中的环也只能访问一次，不能导致页面死循环。 */
export function traceRows(
  spans: SpanRecord[],
  collapsed: Set<string>,
  search = "",
  issuesOnly = false,
) {
  const sorted = [...spans].sort(
    (a, b) =>
      a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
  );
  const ids = new Set(sorted.map((s) => s.id)),
    children = new Map<string | null, SpanRecord[]>();
  for (const span of sorted) {
    const parent =
      span.parentId && ids.has(span.parentId) ? span.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  // 同一父节点优先主 Agent；同毫秒内的阶段仍按准备→模型→工具阅读，不改变条形时间坐标。
  const rank = (span: SpanRecord) =>
    span.name === "context.prepare"
      ? 0
      : span.name === "model.queue"
        ? 1
        : span.name === "gen_ai.request"
          ? 2
          : span.name === "view.tools"
            ? 3
            : 4;
  for (const siblings of children.values())
    siblings.sort((a, b) => {
      if (
        ["agent.run", "view.agent"].includes(a.name) &&
        ["agent.run", "view.agent"].includes(b.name)
      ) {
        const primary =
          Number(Boolean(a.scope.agentId && a.scope.agentId !== "main")) -
          Number(Boolean(b.scope.agentId && b.scope.agentId !== "main"));
        if (primary) return primary;
      }
      return (
        a.startedAt.localeCompare(b.startedAt) ||
        rank(a) - rank(b) ||
        a.id.localeCompare(b.id)
      );
    });
  const rows: TraceRow[] = [],
    seen = new Set<string>();
  const visit = (span: SpanRecord, depth: number, parent: string | null) => {
    if (seen.has(span.id)) return;
    seen.add(span.id);
    rows.push({
      span,
      depth,
      parent,
      hasChildren: (children.get(span.id)?.length ?? 0) > 0,
      match: true,
    });
    for (const child of children.get(span.id) ?? [])
      visit(child, depth + 1, span.id);
  };
  for (const root of children.get(null) ?? []) visit(root, 0, null);
  for (const span of sorted) if (!seen.has(span.id)) visit(span, 0, null);
  if (search.trim() || issuesOnly) {
    const query = search.trim().toLocaleLowerCase(),
      visible = new Set<string>();
    const byId = new Map(rows.map((row) => [row.span.id, row]));
    for (const row of rows) {
      row.match =
        (!issuesOnly || isIssue(row.span.outcome)) &&
        `${spanLabel(row.span)} ${row.span.name} ${row.span.id} ${row.span.scope.agentId ?? "主任务"} ${JSON.stringify(row.span.attributes)}`
          .toLocaleLowerCase()
          .includes(query);
      if (!row.match) continue;
      let current: TraceRow | undefined = row;
      while (current && !visible.has(current.span.id)) {
        visible.add(current.span.id);
        current = current.parent ? byId.get(current.parent) : undefined;
      }
    }
    return rows.filter((row) => visible.has(row.span.id));
  }
  const hidden = new Set<string>();
  return rows.filter((row) => {
    if (row.parent && (hidden.has(row.parent) || collapsed.has(row.parent))) {
      hidden.add(row.span.id);
      return false;
    }
    return true;
  });
}

/** 墙钟仅负责排布。未知终点的已结束记录画刻度而非补造耗时，运行中才延长到当前观察时间。 */
export function traceDomain(
  trace: TraceRecord,
  spans: SpanRecord[],
  now = Date.now(),
) {
  const start = Date.parse(trace.startedAt);
  const end = Math.max(
    start + 1,
    Date.parse(trace.endedAt ?? trace.lastObservedAt ?? trace.startedAt),
    trace.status === "running" && !trace.incomplete ? now : start,
    ...spans.map((s) => Date.parse(s.endedAt ?? s.startedAt)),
  );
  return { start, end, range: end - start };
}
export function spanPosition(
  span: SpanRecord,
  domain: ReturnType<typeof traceDomain>,
) {
  const start = Date.parse(span.startedAt);
  const end = span.endedAt
    ? Date.parse(span.endedAt)
    : span.outcome === "running"
      ? domain.end
      : start;
  const left = Math.max(
    0,
    Math.min(100, ((start - domain.start) / domain.range) * 100),
  );
  return {
    left,
    width: Math.max(
      0,
      Math.min(100 - left, ((end - start) / domain.range) * 100),
    ),
  };
}
