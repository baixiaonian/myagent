/** 浏览器上下文验收：设置容量、长历史自动整理、摘要查看、原文分页和刷新恢复。 */
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("容量设置与压缩后的上下文、历史原文可以刷新恢复", async ({
  page,
  request,
}) => {
  const settings = await (await request.get("/api/v1/settings")).json();
  await request.put("/api/v1/settings", {
    data: {
      baseUrl: "http://127.0.0.1:14318/v1",
      apiProtocol: "responses",
      model: "test",
      apiKey: "context-fixture",
      systemPrompt: "",
      contextWindowTokens: 32768,
      outputReserveTokens: 4096,
      expectedRevision: settings.revision,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "开启新对话" }).click();
  await page.getByRole("textbox", { name: "输入消息" }).fill("上下文长任务");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(
    page
      .getByRole("article", { name: "模型回答" })
      .last()
      .getByRole("button", { name: "复制消息" }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "输入消息" }).fill("继续上下文任务");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(
    page.getByRole("article", { name: "模型回答" }).last(),
  ).toContainText("摘要后继续成功");
  const panel = page.getByRole("complementary", { name: "上下文管理" });
  await expect(panel).toContainText("份摘要");
  await panel.locator("summary").first().click();
  await panel.getByText(/查看摘要/).click();
  await expect(panel).toContainText("历史已完成日志检查");
  await panel.getByRole("button", { name: /查阅/ }).last().click();
  await expect(panel.getByRole("button", { name: "继续读取" })).toBeVisible();
  await panel.getByRole("button", { name: "继续读取" }).click();
  await expect(panel).toContainText("已经确认的历史事实");
  mkdirSync(".cache/acceptance", { recursive: true });
  await page.screenshot({ path: ".cache/acceptance/context-ui.png" });
  await page.reload();
  await expect(
    page.getByRole("complementary", { name: "上下文管理" }),
  ).toContainText("份摘要");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(
    page.getByLabel("上下文窗口（token）", { exact: true }),
  ).toHaveValue("32768");
  await expect(
    page.getByLabel("输出预留（token）", { exact: true }),
  ).toHaveValue("4096");
});
