/** 观测页面的纯布局测试：祖先筛选、异常数据防环，以及并行节点和未知终点的时间语义。 */

import { describe, expect, it } from "vitest";
import {
  spanPosition,
  traceDomain,
  traceRows,
} from "../../apps/web/src/features/observability/trace-view.js";
import type {
  SpanRecord,
  TraceRecord,
} from "../../packages/contracts/src/index.js";

const start = "2026-09-29T00:00:00.000Z";
const span = (
  id: string,
  parentId: string | null,
  patch: Partial<SpanRecord> = {},
): SpanRecord => ({
  id,
  parentId,
  traceId: "t",
  name: "tool.execute",
  scope: {},
  startedAt: start,
  endedAt: "2026-09-29T00:00:10.000Z",
  durationMs: 10000,
  outcome: "ok",
  attributes: {},
  links: [],
  ...patch,
});
const trace: TraceRecord = {
  id: "t",
  rootSpanId: "root",
  scope: {},
  startedAt: start,
  endedAt: "2026-09-29T00:00:20.000Z",
  status: "succeeded",
  previousTraceId: null,
  incomplete: false,
};

describe("Trace 展示模型", () => {
  it("按真实父子关系缩进，折叠隐藏后代，搜索临时展开匹配路径", () => {
    const spans = [
      span("leaf", "member", {
        attributes: { "gen_ai.tool.name": "read_file" },
        outcome: "error",
      }),
      span("root", null),
      span("member", "root"),
      span("other", "root"),
    ];
    expect(traceRows(spans, new Set(["root"])).map((r) => r.span.id)).toEqual([
      "root",
    ]);
    const result = traceRows(spans, new Set(["root"]), "read_file", true);
    expect(result.map((r) => [r.span.id, r.depth, r.match])).toEqual([
      ["root", 0, false],
      ["member", 1, false],
      ["leaf", 2, true],
    ]);
  });
  it("缺失父节点仍展示；损坏的父子环不会遗漏节点或无限递归", () => {
    const rows = traceRows(
      [span("orphan", "not-loaded"), span("a", "b"), span("b", "a")],
      new Set(),
    );
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.span.id)).size).toBe(3);
    expect(rows.find((r) => r.span.id === "orphan")?.depth).toBe(0);
  });
  it("并行请求共用起点，轨道在边界内，不按持续时间串行拼接", () => {
    const a = span("a", null),
      b = span("b", null, {
        startedAt: "2026-09-29T00:00:05.000Z",
        endedAt: "2026-09-29T00:00:15.000Z",
      });
    const domain = traceDomain(trace, [a, b]);
    expect(spanPosition(a, domain)).toEqual({ left: 0, width: 50 });
    expect(spanPosition(b, domain)).toEqual({ left: 25, width: 50 });
  });
  it("中断且没有终点的 Span 只画刻度，不以当前时间补造耗时", () => {
    const unknown = span("unknown", null, {
      endedAt: null,
      durationMs: null,
      outcome: "interrupted",
    });
    const domain = traceDomain(
      {
        ...trace,
        endedAt: null,
        status: "interrupted",
        incomplete: true,
        lastObservedAt: "2026-09-29T00:00:05.000Z",
      },
      [unknown],
      Date.parse("2026-09-30T00:00:00Z"),
    );
    expect(domain.range).toBe(5000);
    expect(spanPosition(unknown, domain).width).toBe(0);
  });
});

// 展示分组只能使用稳定身份，不能把异步成员工作算成 spawn_agent 的持续时间。
it("按 Step 聚合工具、隐藏正常诊断，保留异常与显著等待", async () => {
  const { presentTrace } = await import(
    "../../apps/web/src/features/observability/trace-presentation.js"
  );
  const scope = { runId: "r", stepId: "r:1" };
  const items = [
    span("root", null, { name: "agent.run" }),
    span("step", "root", { name: "agent.step", scope }),
    span("context", "root", { name: "context.prepare", scope }),
    span("call", "step", {
      name: "tool.execute",
      scope: { ...scope, invocationId: "i" },
    }),
    span("permission", "step", {
      name: "tool.permission",
      durationMs: 0,
      scope: { ...scope, invocationId: "i" },
    }),
    span("denied", "permission", {
      name: "tool.dispatch",
      outcome: "denied",
      scope,
    }),
    span("fast", "call", { name: "tool.lock_wait", durationMs: 0 }),
    span("wait", "call", { name: "tool.lock_wait", durationMs: 2000 }),
    span("legacy", "root", { name: "context.prepare" }),
  ];
  const visible = presentTrace(trace, items);
  expect(visible.map((s) => s.id)).not.toContain("permission");
  expect(visible.map((s) => s.id)).not.toContain("fast");
  expect(visible.find((s) => s.id === "context")?.parentId).toBe("step");
  expect(visible.find((s) => s.id === "legacy")?.parentId).toBe("root");
  expect(visible.find((s) => s.id === "call")?.parentId).toBe("tools:step");
  expect(visible.find((s) => s.id === "denied")?.parentId).toBe("call");
  expect(visible.map((s) => s.id)).toContain("wait");
  expect(items.find((s) => s.id === "context")?.parentId).toBe("root");
  const legacyGroup = presentTrace(trace, [
    ...items,
    span("legacy2", "root", { name: "context.prepare" }),
  ]);
  // 旧数据只收拢为明确的未关联组，不能补造具体 Step 归属。
  expect(legacyGroup.find((s) => s.id === "legacy")?.parentId).toBe(
    "unassigned:root",
  );
  expect(legacyGroup.find((s) => s.id === "legacy2")?.parentId).toBe(
    "unassigned:root",
  );
});
it("主成员是独立并行分支；恢复段中的相同 Step 身份不会互相覆盖", async () => {
  const { presentTrace } = await import(
    "../../apps/web/src/features/observability/trace-presentation.js"
  );
  const items = [
    span("root", null, { name: "agent.run", scope: { agentId: "main" } }),
    span("member", "root", { name: "agent.run", scope: { agentId: "a" } }),
    span("step1", "root", {
      name: "agent.step",
      scope: { runId: "r", stepId: "r:1" },
    }),
    span("step2", "root", {
      name: "agent.step",
      traceId: "recovered",
      scope: { runId: "r", stepId: "r:1" },
    }),
    span("context", "root", {
      name: "context.prepare",
      scope: { runId: "r", stepId: "r:1" },
    }),
  ];
  const visible = presentTrace(trace, items);
  expect(visible.find((s) => s.id === "member")?.parentId).toBe("task:t");
  expect(visible.find((s) => s.id === "root")?.parentId).toBe("task:t");
  expect(visible.find((s) => s.id === "context")?.parentId).toBe("step1");
});
