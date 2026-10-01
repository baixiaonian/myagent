/** Skill 产品流程：查看来源不建会话、显式选择/中文输入法、启停、正文与刷新恢复。 */
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("技能设置与聊天选择：无空会话、完整说明、真实加载投影及刷新", async ({
  page,
  request,
}) => {
  const settings = await (await request.get("/api/v1/settings")).json();
  await request.put("/api/v1/settings", {
    data: {
      baseUrl: "http://127.0.0.1:14318/v1",
      apiProtocol: "responses",
      model: "test",
      apiKey: "skills-fixture",
      systemPrompt: "",
      contextWindowTokens: 200000,
      outputReserveTokens: 4096,
      expectedRevision: settings.revision,
    },
  });
  const before = await (await request.get("/api/v1/sessions")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "技能设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "技能", exact: true });
  await expect(dialog.getByText("sales-report", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "sales-report", exact: true })
    .click();
  await expect(dialog).toContainText("E2E_SKILL_RULE");
  await dialog.getByText(/包内资源/).click();
  await expect(dialog).toContainText("references/format.md");
  const toggle = dialog.getByRole("checkbox", {
    name: "启用技能 sales-report",
  });
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  mkdirSync(".cache/acceptance", { recursive: true });
  await page.screenshot({ path: ".cache/acceptance/skills-settings.png" });
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  expect(
    (await (await request.get("/api/v1/sessions")).json()).sessions,
  ).toHaveLength(before.sessions.length);
  await page.getByRole("button", { name: "开启新对话" }).click();
  const input = page.getByRole("textbox", { name: "输入消息" });
  await input.fill("$sales");
  await expect(page.locator(".skill-menu")).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue("$sales-report ");
  await expect(page.locator(".skill-chip")).toContainText("sales-report");
  // IME 确认不发送；技能补全同样服从输入法组合状态。
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(
    (await (await request.get("/api/v1/sessions")).json()).sessions,
  ).toHaveLength(before.sessions.length);
  await input.dispatchEvent("compositionend");
  await input.fill("请整理销售报表");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(
    page
      .getByRole("article", { name: "模型回答" })
      .last()
      .getByRole("button", { name: "复制消息" }),
  ).toBeVisible();
  const panel = page.getByRole("complementary", { name: "上下文管理" });
  await panel.locator("summary").first().click();
  await expect(panel).toContainText("已加载 sales-report");
  await page.screenshot({ path: ".cache/acceptance/skills-chat.png" });
  await page.reload();
  await panel.locator("summary").first().click();
  await expect(panel).toContainText("已加载 sales-report");
  await input.fill("你好");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(
    page
      .getByRole("article", { name: "模型回答" })
      .last()
      .getByRole("button", { name: "复制消息" }),
  ).toBeVisible();
  await expect(panel).not.toContainText("已加载 sales-report");
});
test("来源目录通过设置接入和移除，项目切换不创建聊天", async ({
  page,
  request,
}) => {
  const catalog = await (await request.get("/api/v1/skills")).json();
  const source = catalog.sources[0];
  await page.goto("/");
  await page.getByRole("button", { name: "技能设置" }).click();
  const dialog = page.getByRole("dialog", { name: "技能", exact: true });
  await dialog.getByText(/来源目录 ·/).click();
  await dialog
    .getByRole("textbox", { name: "技能来源路径" })
    .fill(`${source.path}/sales-report`);
  await dialog.getByRole("button", { name: "添加来源", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "移除来源" })).toBeVisible();
  await dialog.getByRole("button", { name: "移除来源" }).click();
  await expect(dialog.getByRole("button", { name: "移除来源" })).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "sales-report", exact: true }),
  ).toBeVisible();
});

test("窄屏技能设置可滚动，目录与选择不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "打开会话列表" }).click();
  await page.getByRole("button", { name: "技能设置" }).click();
  const dialog = page.getByRole("dialog", { name: "技能", exact: true });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".cache/acceptance/skills-mobile.png" });
});
