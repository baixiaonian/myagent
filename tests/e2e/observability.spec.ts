/** 观测 Web 验收：显式开启采集、真实 HTTP 替身聊天、时间轴、原文下载和价格编辑，不接触用户数据。 */
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

test("用量页面展示加权缓存命中和未知请求，保留聊天草稿", async ({
  page,
  request,
}) => {
  const settings = await (await request.get("/api/v1/settings")).json();
  const saved = await request.put("/api/v1/settings", {
    data: {
      apiProtocol: "responses",
      baseUrl: "http://127.0.0.1:14318/v1",
      model: "test",
      apiKey: "cache-test-key",
      systemPrompt: "",
      expectedRevision: settings.revision,
    },
  });
  expect(saved.ok()).toBe(true);
  await page.route("**/api/v1/observability/usage?*", (route) =>
    route.fulfill({
      json: {
        total: {
          requests: 3,
          inputTokens: 12000,
          outputTokens: 100,
          unknownUsage: 0,
          unpricedRequests: 3,
          costs: {},
          cache: { readTokens: 9100, inputTokens: 11000, unknownRequests: 1 },
        },
        groups: [],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("textbox", { name: "输入消息" }).fill("不发送的草稿");
  await page
    .getByRole("button", { name: "执行记录与用量", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "执行记录与用量" });
  await expect(dialog.locator(".obs-metrics")).toContainText(
    "缓存命中 82.7%（1 次未知）",
  );
  await expect(dialog.locator(".obs-metrics")).toContainText(
    "9,100 / 11,000 已知输入 token",
  );
  await page.screenshot({
    path: ".cache/acceptance/cache-metrics-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.locator(".obs-metrics")).toBeVisible();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".cache/acceptance/cache-metrics-mobile.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  await expect(page.getByRole("textbox", { name: "输入消息" })).toHaveValue(
    "不发送的草稿",
  );
});

test("调试开关、时间轴、原始材料、价格和草稿保持", async ({
  page,
  request,
}) => {
  const settings = await (await request.get("/api/v1/settings")).json();
  await request.put("/api/v1/settings", {
    data: {
      apiProtocol: "responses",
      baseUrl: "http://127.0.0.1:14318/v1",
      model: "test",
      apiKey: "obs-e2e-key",
      systemPrompt: "E2E_OBSERVATION_CONTEXT",
      expectedRevision: settings.revision,
    },
  });
  const before = await (await request.get("/api/v1/sessions")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "开启新对话" }).click();
  await page.getByRole("textbox", { name: "输入消息" }).fill("草稿保留");
  await page
    .getByRole("button", { name: "执行记录与用量", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "执行记录与用量" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox", { name: /调试模式/ }).check();
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/v1/observability/settings")).json())
          .debug,
    )
    .toBe(true);
  expect(
    (await (await request.get("/api/v1/sessions")).json()).sessions.length,
  ).toBe(before.sessions.length);
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  await expect(page.getByRole("textbox", { name: "输入消息" })).toHaveValue(
    "草稿保留",
  );
  await page.getByRole("textbox", { name: "输入消息" }).fill("观测测试你好");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(
    page
      .locator(".run-observation")
      .last()
      .getByRole("link", { name: "执行追踪" }),
  ).toBeVisible();
  const id = new URL(page.url()).searchParams.get("session");
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/v1/sessions/${id}`)).json()).activeRun,
    )
    .toBeNull();
  await page
    .getByRole("textbox", { name: "输入消息" })
    .fill("链路页打开仍保留的草稿");
  const tracePromise = page.waitForEvent("popup");
  await page
    .locator(".run-observation")
    .last()
    .getByRole("link", { name: "执行追踪" })
    .click();
  const trace = await tracePromise;
  await trace.waitForURL(/\/traces\//);
  await trace.getByRole("button", { name: "展开", exact: true }).click();
  await expect(
    trace.locator(".trace-node-select").filter({ hasText: "模型请求" }).first(),
  ).toBeVisible();
  await trace
    .locator(".trace-node-select")
    .filter({ hasText: "模型请求" })
    .first()
    .click();
  await expect(trace).toHaveURL(/\?span=/);
  await expect(
    trace.getByRole("complementary", { name: "节点详情" }),
  ).toBeVisible();
  const input = trace.locator(".obs-capture").filter({ hasText: "原始输入" });
  await expect(input.locator(".obs-raw")).toContainText(
    "E2E_OBSERVATION_CONTEXT",
  );
  await input.getByRole("checkbox", { name: "格式化 JSON" }).check();
  await expect(input.locator(".obs-raw")).toContainText('"store": false');
  const downloadPromise = trace.waitForEvent("download");
  await input.getByRole("link", { name: "下载原始文件" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const pieces: Buffer[] = [];
  for await (const piece of stream) pieces.push(Buffer.from(piece));
  const callId = (
    await request
      .get(`/api/v1/observability/calls?sessionId=${id}`)
      .then((r) => r.json())
  ).items[0].id;
  const detail = await (
    await request.get(`/api/v1/observability/calls/${callId}`)
  ).json();
  expect(createHash("sha256").update(Buffer.concat(pieces)).digest("hex")).toBe(
    detail.captures.find((c: { direction: string }) => c.direction === "input")
      .sha256,
  );
  await trace.screenshot({
    path: ".cache/acceptance/observability-trace.png",
    fullPage: true,
  });
  await trace.reload();
  await expect(
    trace.getByRole("complementary", { name: "节点详情" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "输入消息" })).toHaveValue(
    "链路页打开仍保留的草稿",
  );
  await trace.close();
  await page
    .getByRole("button", { name: "执行记录与用量", exact: true })
    .click();
  await dialog.getByRole("button", { name: "模型价格", exact: true }).click();
  await dialog.getByLabel("接口基础地址").fill("http://127.0.0.1:14318/v1");
  await dialog.getByLabel("模型 ID", { exact: true }).fill("test");
  await dialog.getByLabel("普通输入单价").fill("2");
  await dialog.getByLabel("输出单价", { exact: true }).fill("10");
  await dialog.getByRole("button", { name: "保存价格" }).click();
  await expect(dialog.locator(".obs-table")).toContainText("手动价格");
  await dialog.getByRole("checkbox", { name: /调试模式/ }).uncheck();
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/v1/observability/settings")).json())
          .debug,
    )
    .toBe(false);
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  await page.reload();
  await expect(
    page
      .locator(".run-observation")
      .last()
      .getByRole("link", { name: "执行追踪" }),
  ).toHaveCount(0);
});

/** 长列表独立验证：新记录到达和每秒刷新不能丢掉已展开的第二页。 */
test("追踪分页在轮询和新记录到达后保持展开内容", async ({ page }) => {
  let count = 65;
  await page.route("**/api/v1/observability/traces?*", (route) => {
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset") ?? 0,
    );
    const all = Array.from({ length: count }, (_, i) => ({
      id: `trace-${count - i}`,
      rootSpanId: `root-${count - i}`,
      scope: { purpose: "agent" },
      startedAt: new Date(Date.UTC(2026, 8, 29, 0, 0, count - i)).toISOString(),
      endedAt: new Date(Date.UTC(2026, 8, 29, 0, 1, count - i)).toISOString(),
      status: "succeeded",
      previousTraceId: null,
      incomplete: false,
    }));
    return route.fulfill({
      json: {
        items: all.slice(offset, offset + 50),
        nextOffset: offset + 50 < all.length ? offset + 50 : null,
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "执行记录与用量", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "执行记录与用量" });
  await dialog.getByRole("button", { name: "更多记录", exact: true }).click();
  await expect(dialog.locator(".obs-task-header code")).toHaveCount(65);
  count = 66;
  await expect(dialog.locator(".obs-task-header code")).toHaveCount(66);
  await expect(
    dialog.getByRole("button", { name: "更多记录", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.locator(".obs-task-header code").filter({ hasText: /^trace-1$/ }),
  ).toHaveCount(1);
});

/** 旧版审批拆段仍可查阅，但一个主任务只显示一张卡，不能将残留段状态当成任务状态。 */
test("同一团队的恢复段在同页归组，不要求手动切换 Trace", async ({
  page,
  context,
}) => {
  const segments = Array.from({ length: 28 }, (_, i) => ({
    id: `old-segment-${i}`,
    rootSpanId: `root-${i}`,
    scope: {
      runId: i % 2 ? "member-run" : "main-run",
      rootRunId: "main-run",
      purpose: "agent",
    },
    startedAt: new Date(Date.UTC(2026, 8, 29, 0, 0, 28 - i)).toISOString(),
    endedAt: null,
    status: "running",
    previousTraceId: null,
    incomplete: true,
    task: {
      runId: "main-run",
      status: "cancelled",
      error: { code: "cancelled", message: "运行已停止。" },
    },
  }));
  await context.route("**/api/v1/observability/traces?*", (route) =>
    route.fulfill({ json: { items: segments, nextOffset: null } }),
  );
  await context.route(
    "**/api/v1/observability/traces/old-segment-*",
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      return route.fulfill({
        json: {
          trace: segments.find((t) => t.id === id),
          spans: [],
          events: [],
          nextSpanOffset: null,
          nextEventOffset: null,
        },
      });
    },
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "执行记录与用量", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "执行记录与用量" });
  await expect(dialog.locator(".obs-task")).toHaveCount(1);
  await expect(dialog.locator(".obs-task-list")).toContainText("任务 · 已停止");
  await expect(dialog.locator(".obs-task-list")).toContainText(
    "已加载 28 个执行段",
  );
  const opened = page.waitForEvent("popup");
  await dialog.getByRole("link", { name: "打开链路" }).click();
  const trace = await opened;
  await expect(
    trace.getByText("同一任务 · 已关联 28 个执行段，按 Agent 归组展示"),
  ).toBeVisible();
  await expect(trace.getByRole("combobox", { name: "执行段" })).toHaveCount(0);
  await expect(trace.locator(".trace-notice").first()).toContainText("已停止");
  await trace.reload();
  await expect(
    trace.getByText("同一任务 · 已关联 28 个执行段，按 Agent 归组展示"),
  ).toBeVisible();
  await trace.close();
});
