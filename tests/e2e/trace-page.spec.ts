/** Trace 独立页面验收：协议替身构造长树与并行节点，验证深链接、右侧详情、分页和键盘，不请求真实模型。 */
import { expect, test } from "@playwright/test";

test("长链路节点直达、祖先筛选、折叠、历史导航和窄屏详情", async ({ page }) => {
  const startedAt = "2026-09-29T01:00:00.000Z";
  const trace = {
    id: "tree-test",
    rootSpanId: "root",
    scope: {},
    startedAt,
    endedAt: "2026-09-29T01:01:00.000Z",
    status: "failed",
    previousTraceId: "older-trace",
    incomplete: false,
  };
  const spans = [
    {
      id: "root",
      parentId: null,
      name: "agent.run",
      startedAt,
      endedAt: trace.endedAt,
      durationMs: 60000,
    },
    {
      id: "member",
      parentId: "root",
      name: "agent.run",
      startedAt,
      endedAt: trace.endedAt,
      durationMs: 60000,
    },
    ...Array.from({ length: 220 }, (_, i) => ({
      id: `tool-${i}`,
      parentId: "member",
      name: "tool.execute",
      startedAt: new Date(Date.parse(startedAt) + i * 200).toISOString(),
      endedAt: new Date(Date.parse(startedAt) + i * 200 + 1000).toISOString(),
      durationMs: 1000,
    })),
  ].map((s) => ({
    ...s,
    traceId: trace.id,
    scope: { agentId: s.id === "root" ? "main" : "member-a" },
    outcome: s.id === "tool-210" ? "error" : "ok",
    attributes: {
      "gen_ai.tool.name":
        s.name === "tool.execute"
          ? s.id === "tool-210"
            ? "write_file"
            : "read_file"
          : "",
    },
    links:
      s.id === "tool-210"
        ? [{ traceId: "older-trace", spanId: "old-node" }]
        : [],
  }));
  const events = Array.from({ length: 202 }, (_, i) => ({
    id: `event-${i}`,
    traceId: trace.id,
    spanId: i === 201 ? "tool-210" : "root",
    name: i === 201 ? "tool.failed" : "checkpoint",
    at: startedAt,
    attributes: { reason: "版本冲突" },
  }));
  let metadataRequests = 0;
  await page.route("**/api/v1/observability/traces/tree-test?*", (route) => {
    metadataRequests++;
    const query = new URL(route.request().url()).searchParams;
    const spanOffset = Number(query.get("spanOffset")),
      eventOffset = Number(query.get("eventOffset"));
    return route.fulfill({
      json: {
        trace,
        spans: spans.slice(spanOffset, spanOffset + 200),
        events: events.slice(eventOffset, eventOffset + 200),
        nextSpanOffset:
          spanOffset + 200 < spans.length ? spanOffset + 200 : null,
        nextEventOffset:
          eventOffset + 200 < events.length ? eventOffset + 200 : null,
      },
    });
  });
  await page.goto("/traces/tree-test?span=tool-210");
  const panel = page.getByRole("complementary", { name: "节点详情" });
  await expect(
    panel.getByRole("heading", { name: "工具调用 · write_file" }),
  ).toBeVisible();
  await expect(page.locator(".trace-tree tbody tr")).toHaveCount(223);
  expect(metadataRequests).toBeGreaterThanOrEqual(2);
  await panel.getByRole("button", { name: "加载更多事件" }).click();
  await expect(panel).toContainText("tool.failed");
  await expect(panel).toContainText("版本冲突");
  await expect(page.locator(".trace-tree tbody tr")).toHaveCount(223);
  await page.getByRole("searchbox", { name: "搜索节点" }).fill("write_file");
  await expect(page.locator(".trace-tree tbody tr")).toHaveCount(3);
  await page.getByRole("button", { name: "只看异常" }).click();
  await expect(page.locator(".trace-tree tbody tr")).toHaveCount(3);
  await page
    .getByRole("searchbox", { name: "搜索节点" })
    .fill("不匹配的关键字");
  await expect(page.getByText("当前已加载节点没有匹配项")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await panel.getByRole("button", { name: "关闭节点详情" }).click();
  await page.getByRole("button", { name: "折叠", exact: true }).click();
  await expect(page.locator(".trace-tree tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "展开", exact: true }).click();
  await expect(page.locator(".trace-tree tbody tr")).toHaveCount(223);
  await page.locator('[data-span-id="root"] .trace-node-select').click();
  await expect(page).toHaveURL(/span=root$/);
  await page.goBack();
  await expect(panel).toHaveCount(0);
  await page.goForward();
  await expect(panel).toBeVisible();
  await page.reload();
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    panel.getByRole("button", { name: "关闭节点详情" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".cache/acceptance/trace-inspector-mobile.png",
  });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "搜索节点" })).toBeVisible();
});

test("迟到的节点详情不覆盖新选择，选中节点直接展示原始正文", async ({
  page,
}) => {
  const base = {
    traceId: "race-test",
    startedAt: "2026-09-29T01:00:00.000Z",
    endedAt: "2026-09-29T01:00:01.000Z",
    outcome: "ok",
    durationMs: 1000,
    links: [],
  };
  const spans = [
    {
      ...base,
      id: "root",
      parentId: null,
      name: "agent.run",
      scope: {},
      attributes: {},
    },
    ...["a", "b"].map((id) => ({
      ...base,
      id,
      parentId: "root",
      name: "gen_ai.request",
      scope: { callId: id },
      attributes: { "gen_ai.request.model": `model-${id}` },
    })),
  ];
  await page.route("**/api/v1/observability/traces/race-test?*", (route) =>
    route.fulfill({
      json: {
        trace: {
          id: "race-test",
          rootSpanId: "root",
          scope: {},
          startedAt: base.startedAt,
          endedAt: base.endedAt,
          status: "succeeded",
          incomplete: false,
          previousTraceId: null,
        },
        spans,
        events: [],
        nextSpanOffset: null,
        nextEventOffset: null,
      },
    }),
  );
  let releaseA: (() => void) | undefined,
    startedA = false,
    bodyReads = 0;
  const waiting = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  await page.route("**/api/v1/observability/calls/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (id === "a") {
      startedA = true;
      await waiting;
    }
    await route.fulfill({
      json: {
        call: {
          id,
          traceId: "race-test",
          spanId: id,
          scope: {},
          model: `model-${id}`,
          protocol: "responses",
          status: "succeeded",
          sent: true,
          debug: true,
          startedAt: base.startedAt,
          endedAt: base.endedAt,
          firstChunkMs: 5,
          firstTextMs: 10,
          cost: null,
          usage: null,
          price: null,
          unpricedReason: "测试无价格",
        },
        captures: [
          {
            id: `capture-${id}`,
            callId: id,
            direction: "input",
            status: "complete",
            bytes: 10,
            contentType: "application/json",
          },
        ],
      },
    });
  });
  await page.route("**/captures/*?*", (route) => {
    bodyReads++;
    return route.fulfill({
      json: {
        text: JSON.stringify({ input: "model-b body" }),
        nextOffset: null,
        capture: {
          direction: "input",
          status: "complete",
          contentType: "application/json",
        },
      },
    });
  });
  await page.goto("/traces/race-test?span=a");
  const panel = page.getByRole("complementary", { name: "节点详情" });
  await expect.poll(() => startedA).toBe(true);
  await page.locator('[data-span-id="b"] .trace-node-select').click();
  await expect(panel.locator(".trace-detail-heading")).toContainText("model-b");
  releaseA?.();
  await expect(panel.locator(".trace-detail-heading")).not.toContainText(
    "model-a",
  );
  await expect(panel.locator(".obs-raw")).toContainText("model-b body");
  expect(bodyReads).toBe(1);
});

test("失效 Trace 链接有错误与返回入口，不创建对话", async ({
  page,
  request,
}) => {
  const before = (await (await request.get("/api/v1/sessions")).json()).sessions
    .length;
  await page.goto("/traces/no-such-trace");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("link", { name: "返回对话" })).toBeVisible();
  expect(
    (await (await request.get("/api/v1/sessions")).json()).sessions.length,
  ).toBe(before);
});

/** 多 Agent 的展示模型和复制边界：固定协议证据，避免为界面验收产生真实模型费用。 */
test("Step 树、成员跳转、上下文差异、同页详情与完整原文复制", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const startedAt = "2026-09-29T01:00:00.000Z",
    endedAt = "2026-09-29T01:00:10.000Z";
  const trace = {
    id: "semantic-test",
    rootSpanId: "root",
    scope: {},
    startedAt,
    endedAt,
    status: "succeeded",
    previousTraceId: null,
    incomplete: false,
  };
  const make = (
    id: string,
    parentId: string | null,
    name: string,
    scope: object,
    attributes: object = {},
    durationMs = 1000,
  ) => ({
    id,
    parentId,
    name,
    scope,
    attributes,
    traceId: trace.id,
    startedAt,
    endedAt,
    durationMs,
    outcome: "completed",
    links: [],
  });
  const main = { runId: "r", agentId: "main", agentName: "主 Agent" },
    step = { ...main, stepId: "r:1" };
  const spans = [
    make("root", null, "agent.run", main),
    make("step", "root", "agent.step", step, { index: 1 }),
    make("prepare", "step", "context.prepare", step),
    make(
      "model",
      "step",
      "gen_ai.request",
      { ...step, callId: "model" },
      { "gen_ai.request.model": "fixture" },
    ),
    make(
      "spawn",
      "step",
      "tool.execute",
      { ...step, invocationId: "i" },
      { "gen_ai.tool.name": "spawn_agent", "myagent.target.agent": "a" },
    ),
    make(
      "permission",
      "spawn",
      "tool.permission",
      { ...step, invocationId: "i" },
      {},
      0,
    ),
    make("member", "root", "agent.run", {
      agentId: "a",
      agentName: "代码分析员",
      runId: "member-run",
    }),
    make(
      "member-step",
      "member",
      "agent.step",
      { agentId: "a", runId: "member-run", stepId: "member-run:1" },
      { index: 1 },
    ),
  ];
  const events = [
    {
      id: "e",
      traceId: trace.id,
      spanId: "prepare",
      at: startedAt,
      name: "context.added",
      attributes: {
        count: 1,
        omitted: 0,
        entries: JSON.stringify([
          {
            id: "tool:read_file",
            kind: "tools",
            label: "read_file",
            hash: "h",
            characters: 320,
          },
        ]),
      },
    },
  ];
  await page.route("**/observability/traces/semantic-test?*", (route) =>
    route.fulfill({
      json: {
        trace,
        spans,
        events,
        nextSpanOffset: null,
        nextEventOffset: null,
      },
    }),
  );
  await page.route("**/spans/*/evidence", (route) =>
    route.fulfill({ json: {} }),
  );
  const raw = '{"messages":[{"role":"user","content":"完整输入最后一段"}]}';
  let outputReads = 0;
  const captures = ["input", "output"].map((direction) => ({
    id: direction,
    callId: "model",
    direction,
    status: "complete",
    bytes: raw.length,
    contentType:
      direction === "input" ? "application/json" : "text/event-stream",
  }));
  await page.route("**/observability/calls/model", (route) =>
    route.fulfill({
      json: {
        call: {
          id: "model",
          traceId: trace.id,
          spanId: "model",
          scope: {},
          model: "fixture",
          protocol: "responses",
          status: "succeeded",
          sent: true,
          debug: true,
          startedAt,
          endedAt,
          usage: null,
          cost: null,
          price: null,
        },
        captures,
      },
    }),
  );
  await page.route("**/calls/model/captures/*?*", (route) => {
    const url = new URL(route.request().url());
    const direction = url.pathname.split("/").at(-1)!;
    const offset = Number(url.searchParams.get("offset"));
    if (direction === "output") outputReads++;
    return route.fulfill({
      json: {
        capture: captures.find((c) => c.id === direction),
        text:
          direction === "input"
            ? offset === 0
              ? raw.slice(0, 15)
              : raw.slice(15)
            : 'data: {"output":"测试回答"}\n\n',
        nextOffset: direction === "input" && offset === 0 ? 15 : null,
      },
    });
  });
  await page.goto("/traces/semantic-test");
  await page.getByRole("button", { name: "展开", exact: true }).click();
  await expect(page.locator('[data-span-id="permission"]')).toHaveCount(0);
  await expect(page.locator('[data-span-id="tools:step"]')).toBeVisible();
  await page.locator('[data-span-id="spawn"] .trace-node-select').click();
  const panel = page.getByRole("complementary", { name: "节点详情" });
  await panel.getByRole("link", { name: "查看 代码分析员 的执行分支" }).click();
  await expect(
    panel.getByRole("heading", { name: "代码分析员", exact: true }),
  ).toBeVisible();
  await page.locator('[data-span-id="prepare"] .trace-node-select').click();
  await expect(
    panel.getByRole("heading", { name: "新增到上下文 · 1", exact: true }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("region", { name: "本次上下文变化" })
      .locator(".trace-source-list"),
  ).toContainText("read_file");
  await page.screenshot({
    path: ".cache/acceptance/trace-context-sections.png",
  });
  await page.locator('[data-span-id="model"] .trace-node-select').click();
  await expect(panel.locator(".trace-detail-tabs")).toHaveCount(0);
  const input = panel.getByRole("region", { name: "原始输入", exact: true });
  const output = panel.getByRole("region", { name: "原始输出", exact: true });
  await expect(input.locator(".obs-raw")).toContainText(raw.slice(0, 15));
  await expect(output.locator(".obs-raw")).toContainText("测试回答");
  await input.getByRole("button", { name: "复制完整原始输入" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(raw);
  await expect(input).toContainText("页面仅加载部分内容");
  expect(outputReads).toBeGreaterThan(0);
  await page.screenshot({ path: ".cache/acceptance/trace-model-sections.png" });
});
