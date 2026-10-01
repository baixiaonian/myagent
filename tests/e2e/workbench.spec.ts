/** 工作台交互验收：真实临时服务验证过程折叠、完整窗口占比、设置草稿和手机布局。
 * 模型为本地协议替身；不使用用户的模型配置、目录或付费调用。 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const settings = await (await request.get("/api/v1/settings")).json();
  await request.put("/api/v1/settings", {
    data: {
      baseUrl: "http://127.0.0.1:14318/v1",
      apiProtocol: "responses",
      model: "test",
      apiKey: "workbench-fixture",
      systemPrompt: "",
      contextWindowTokens: 200000,
      outputReserveTokens: 4096,
      expectedRevision: settings.revision,
    },
  });
});

test("整轮执行默认折叠，窗口占比使用冻结容量且能键盘关闭明细", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "输入消息" })
    .fill("Agent 查询当前时间，按需维护计划");
  await page.getByRole("button", { name: "发送消息" }).click();
  const process = page.locator(".message.assistant .run-process").last();
  await expect(process.locator(":scope > summary")).toContainText(
    "执行记录 · 3 次工具调用",
  );
  await expect(process).not.toHaveAttribute("open", "");
  await expect(
    page.getByText("Agent 任务已完成，已查询时间并更新计划。", { exact: true }),
  ).toBeVisible();
  await process.locator(":scope > summary").click();
  await expect(process.locator(".execution-step").first()).toBeVisible();
  const id = new URL(page.url()).searchParams.get("session");
  const view = await (
    await request.get(`/api/v1/sessions/${id}/context`)
  ).json();
  expect(view.capacity.contextWindowTokens).toBe(200000);
  const percent = Math.round(
    (view.stats.estimatedTokens / view.capacity.contextWindowTokens) * 100,
  );
  const panel = page.getByRole("complementary", { name: "上下文管理" });
  await expect(panel.locator("summary").first()).toContainText(
    `上下文 ${percent}%`,
  );
  await panel.locator("summary").first().click();
  await expect(
    panel.getByRole("progressbar", { name: "上下文窗口占用" }),
  ).toHaveAttribute("max", "200000");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(
    await page
      .locator(".workspace-header")
      .evaluate((node) => node.getBoundingClientRect().top),
  ).toBe(0);
  await page.keyboard.press("Escape");
  await expect(panel.locator(".context-popover")).not.toBeVisible();
  await expect(panel.locator("summary").first()).toBeFocused();
  // 修改下一轮设置不改当前 Run 的窗口，避免 UI 百分比因设置变化而跳变。
  const settings = await (await request.get("/api/v1/settings")).json();
  await request.put("/api/v1/settings", {
    data: {
      baseUrl: settings.baseUrl,
      apiProtocol: settings.apiProtocol,
      model: settings.model,
      systemPrompt: settings.systemPrompt,
      contextWindowTokens: 100000,
      outputReserveTokens: 4096,
      expectedRevision: settings.revision,
    },
  });
  await page.reload();
  await expect(panel.locator("summary").first()).toContainText(
    `上下文 ${percent}%`,
  );
  await panel.locator("summary").first().click();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("max", "200000");
  await page.screenshot({ path: ".cache/acceptance/workbench-context.png" });
});

test("设置导航、技能空搜索、添加入口与 MCP 未保存草稿保护", async ({
  page,
  request,
}) => {
  const before = await (await request.get("/api/v1/sessions")).json();
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "输入消息" });
  await composer.fill("不要丢失这份对话草稿");
  await page.getByRole("button", { name: "技能设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "搜索技能" }).fill("no-such-skill");
  await expect(
    dialog.getByText("没有匹配的技能，试试其他名称或范围。"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "添加技能", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "技能来源路径" }),
  ).toBeFocused();
  await dialog.getByRole("textbox", { name: "搜索技能" }).fill("");
  await dialog
    .getByRole("button", { name: "sales-report", exact: true })
    .click();
  await expect(dialog.locator(".skill-detail")).toContainText("E2E_SKILL_RULE");
  await page.screenshot({ path: ".cache/acceptance/workbench-skills.png" });
  await dialog
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "MCP 服务", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "＋ 添加 MCP", exact: true })
    .click();
  await dialog
    .getByLabel("服务名称", { exact: true })
    .fill("my-unsaved-server");
  await dialog
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "技能", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "留在当前页" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "留在当前页" }).click();
  await expect(dialog.getByLabel("服务名称", { exact: true })).toHaveValue(
    "my-unsaved-server",
  );
  await dialog.getByRole("button", { name: "取消编辑" }).click();
  await dialog
    .getByRole("textbox", { name: "搜索 MCP 服务" })
    .fill("no-such-server");
  await page.screenshot({ path: ".cache/acceptance/workbench-mcp.png" });
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  await expect(composer).toHaveValue("不要丢失这份对话草稿");
  const after = await (await request.get("/api/v1/sessions")).json();
  expect(after.sessions.length).toBe(before.sessions.length);
});

test("手机设置导航可切换且不溢出，技能菜单支持 Escape 和外部点击", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "选择本轮技能", exact: true }).click();
  await page.getByRole("textbox", { name: "查找本轮技能" }).fill("missing");
  await expect(page.getByText("没有匹配的技能，试试其他名称。")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".skill-menu")).not.toBeVisible();
  await page.getByRole("button", { name: "选择本轮技能", exact: true }).click();
  await page.getByRole("heading", { name: "想做点什么？" }).click();
  await expect(page.locator(".skill-menu")).not.toBeVisible();
  await page.getByRole("button", { name: "打开会话列表" }).click();
  await page.getByRole("button", { name: "技能设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "MCP 服务", exact: true })
    .click();
  await expect(dialog).toHaveAccessibleName("MCP 服务");
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  expect(
    await page
      .locator(".settings-content")
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: ".cache/acceptance/workbench-mobile.png" });
});
