/** 长期记忆浏览器验收：独立设置不会建空会话，人工编辑/遗忘/撤销与后台来源可刷新恢复。 */
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("长期记忆管理、后台提炼和来源查阅", async ({ page, request }) => {
  const settings = await (await request.get("/api/v1/settings")).json();
  await request.put("/api/v1/settings", {
    data: {
      baseUrl: "http://127.0.0.1:14318/v1",
      apiProtocol: "responses",
      model: "test",
      apiKey: "memory-fixture",
      systemPrompt: "",
      expectedRevision: settings.revision,
    },
  });
  const before = await (await request.get("/api/v1/sessions")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "长期记忆", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "长期记忆" });
  await expect(
    dialog.getByLabel("启用长期记忆", { exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("启用长期记忆", { exact: true }).check();
  await dialog
    .getByRole("button", { name: "保存记忆设置", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("已保存");
  expect(
    (await (await request.get("/api/v1/sessions")).json()).sessions.length,
  ).toBe(before.sessions.length);
  await dialog.getByRole("button", { name: "新增记忆", exact: true }).click();
  await dialog.getByLabel("标题", { exact: true }).fill("页面偏好");
  await dialog
    .getByLabel("记忆正文", { exact: true })
    .fill("请用中文解释并给出具体例子。");
  await dialog.getByRole("button", { name: "保存记忆", exact: true }).click();
  await expect(
    dialog.locator(".memory-card").filter({ hasText: "页面偏好" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "长期记忆", exact: true }).click();
  const card = dialog.locator(".memory-card").filter({ hasText: "页面偏好" });
  await card.getByRole("button", { name: "查看与编辑" }).click();
  await dialog
    .getByLabel("记忆正文", { exact: true })
    .fill("中文解释，先举例再讲原理。");
  await dialog.getByRole("button", { name: "保存记忆", exact: true }).click();
  await expect(card).toContainText("先举例");
  await card.getByRole("button", { name: "查看与编辑" }).click();
  await dialog.getByRole("button", { name: "忘记这条记忆" }).click();
  await expect(card).toHaveCount(0);
  await dialog.getByText("变更记录", { exact: true }).click();
  await dialog.getByRole("button", { name: "撤销此变更" }).click();
  await expect(card).toContainText("先举例");
  const session = await (
    await request.post("/api/v1/sessions", {
      data: { requestId: crypto.randomUUID() },
    })
  ).json();
  const id = session.id ?? session.session.id;
  const start = await (
    await request.post(`/api/v1/sessions/${id}/runs`, {
      data: {
        requestId: crypto.randomUUID(),
        expectedRevision: session.revision ?? session.session.revision,
        content: "记忆验收：日志目录是星舟仓库。",
      },
    })
  ).json();
  await expect
    .poll(async () => {
      const s = await (await request.get(`/api/v1/sessions/${id}`)).json();
      return s.latestRun?.id === start.run.id ? s.latestRun.status : "";
    })
    .toBe("succeeded");
  await request.post("/api/v1/memories/jobs", {
    data: { sessionId: id, requestId: crypto.randomUUID() },
  });
  await expect(dialog).toContainText("星舟知识", { timeout: 15000 });
  await dialog
    .locator(".memory-card")
    .filter({ hasText: "星舟知识" })
    .getByRole("button", { name: "查看与编辑" })
    .click();
  await dialog.getByText(/来源与证据/).click();
  await dialog
    .getByRole("button", { name: /查阅来源/ })
    .first()
    .click();
  await expect(dialog.locator(".memory-source")).toContainText("星舟仓库");
  mkdirSync(".cache/acceptance", { recursive: true });
  await page.screenshot({ path: ".cache/acceptance/memory-ui.png" });
});
