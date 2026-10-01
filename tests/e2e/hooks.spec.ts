/** Hook 产品验收：无空会话、配置预览和准确授权、真实进程执行、刷新后的持久记录。 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("Hook 设置预览确认、执行记录与刷新", async ({ page, request }) => {
  const { hookPackage } = JSON.parse(
    readFileSync(".cache/execution-e2e.json", "utf8"),
  );
  const before = await (await request.get("/api/v1/sessions")).json();
  const settings = await (await request.get("/api/v1/settings")).json();
  await request.put("/api/v1/settings", {
    data: {
      baseUrl: "http://127.0.0.1:14318/v1",
      apiProtocol: "responses",
      model: "test",
      apiKey: "hook-fixture",
      systemPrompt: "",
      expectedRevision: settings.revision,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Hook 设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Hook", exact: true });
  const text = JSON.stringify(
    {
      schemaVersion: 1,
      hooks: [
        {
          id: "prepare",
          event: "RunStart",
          enabled: true,
          packagePath: hookPackage,
          entry: "main.mjs",
          interpreter: "node",
          args: [],
          timeoutMs: 10000,
          permissions: { writePaths: [], networkDomains: [] },
        },
      ],
    },
    null,
    2,
  );
  await dialog.getByRole("textbox", { name: "Hook 配置 JSON" }).fill(text);
  await dialog.getByRole("button", { name: "预览配置与权限" }).click();
  await expect(dialog).toContainText("项目与脚本包只读");
  expect(
    (await (await request.get("/api/v1/hooks/config?scope=user")).json())
      .document.hooks,
  ).toHaveLength(0);
  await dialog.getByRole("button", { name: "确认授权并保存" }).click();
  await expect(dialog.getByRole("status")).toContainText("配置已生效");
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  expect(
    (await (await request.get("/api/v1/sessions")).json()).sessions,
  ).toHaveLength(before.sessions.length);
  await page.getByRole("button", { name: "开启新对话" }).click();
  await page.getByRole("textbox", { name: "输入消息" }).fill("你好");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.locator(".hook-process")).toBeVisible();
  await page.locator(".hook-process summary").click();
  await expect(page.locator(".hook-process")).toContainText("已完成");
  await page.reload();
  await page.locator(".hook-process summary").click();
  await expect(page.locator(".hook-process")).toContainText("RunStart");
  await page.screenshot({ path: ".cache/acceptance/hooks-chat.png" });
  // 仅清理本例的专用配置，后续产品回归不继承 Hook。
  const current = await (
      await request.get("/api/v1/hooks/config?scope=user")
    ).json(),
    empty = JSON.stringify({ schemaVersion: 1, hooks: [] });
  const preview = await (
    await request.put("/api/v1/hooks/config", {
      data: { scope: "user", text: empty, expectedRevision: current.revision },
    })
  ).json();
  expect(
    (
      await request.put("/api/v1/hooks/config", {
        data: {
          scope: "user",
          text: empty,
          expectedRevision: current.revision,
          expectedVersion: preview.version,
        },
      })
    ).ok(),
  ).toBe(true);
});
