/** 插件 Web 验收：预览确认、重开恢复、更新回退、禁用卸载；专用临时包不影响用户目录。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("插件安装、使用入口、版本管理和卸载不创建空对话", async ({
  page,
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), "myagent-plugin-web-"));
  mkdirSync(join(root, "skills/report"), { recursive: true });
  const manifest = (version: string) =>
    writeFileSync(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "web-report",
        version,
        description: "浏览器验收报告插件",
      }),
    );
  manifest("1.0.0");
  writeFileSync(
    join(root, "skills/report/SKILL.md"),
    "---\nname: report\ndescription: 整理中文报告\n---\n写出可验证的结论。",
  );
  try {
    const settings = await (await request.get("/api/v1/settings")).json();
    await request.put("/api/v1/settings", {
      data: {
        baseUrl: "http://127.0.0.1:14318/v1",
        apiProtocol: "responses",
        model: "test",
        apiKey: "fixture",
        systemPrompt: "",
        expectedRevision: settings.revision,
      },
    });
    const before = await (await request.get("/api/v1/sessions")).json();
    await page.goto("/");
    await page
      .getByRole("textbox", { name: "输入消息" })
      .fill("保留我的插件测试草稿");
    await page.getByRole("button", { name: "插件设置", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "插件", exact: true });
    await dialog.getByLabel("插件作用域").selectOption("user");
    await dialog.getByLabel("插件来源", { exact: true }).fill(root);
    await dialog.getByRole("button", { name: "检查并预览安装" }).click();
    await expect(
      dialog.getByRole("button", { name: "确认版本与权限并启用", exact: true }),
    ).toBeVisible();
    expect(
      await (await request.get("/api/v1/plugins?scope=user")).json(),
    ).toHaveLength(0);
    await dialog.getByRole("button", { name: "关闭弹窗" }).click();
    await expect(page.getByRole("textbox", { name: "输入消息" })).toHaveValue(
      "保留我的插件测试草稿",
    );
    await page.getByRole("button", { name: "插件设置", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "插件", exact: true });
    await dialog.getByLabel("插件作用域").selectOption("user");
    await dialog
      .locator("summary")
      .filter({ hasText: "安装与更新任务" })
      .click();
    await dialog.getByRole("button", { name: "查看任务" }).first().click();
    await dialog
      .getByRole("button", { name: "确认版本与权限并启用", exact: true })
      .click();
    const card = dialog
      .locator(".plugin-list .plugin-card")
      .filter({ hasText: "web-report" });
    await expect(card).toContainText("已启用");
    await dialog.evaluate((e) => (e.scrollTop = 0));
    await page.screenshot({ path: ".cache/acceptance/plugins-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({ path: ".cache/acceptance/plugins-mobile.png" });
    await page.setViewportSize({ width: 1360, height: 900 });
    manifest("2.0.0");
    await card.getByRole("button", { name: "检查更新", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "确认版本与权限并启用", exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "确认版本与权限并启用", exact: true })
      .click();
    await expect(card).toContainText("2.0.0");
    await card.getByRole("button", { name: "回退上一版", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "确认版本与权限并启用", exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "确认版本与权限并启用", exact: true })
      .click();
    await expect(card).toContainText("1.0.0");
    await card.getByRole("button", { name: "禁用", exact: true }).click();
    await expect(card).toContainText("已禁用");
    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "卸载", exact: true }).click();
    await expect(card).toHaveCount(0);
    expect(
      (await (await request.get("/api/v1/sessions")).json()).sessions,
    ).toHaveLength(before.sessions.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
