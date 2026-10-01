/** 团队 Web 验收：成员不污染侧栏；真实命令审批归属成员，刷新后恢复团队和消息。 */
import { expect, test } from "@playwright/test";

test("团队成员审批、统一交付、刷新与关闭成员", async ({ page, request }) => {
  const config = await (await request.get("/api/v1/settings")).json();
  await request.put("/api/v1/settings", {
    data: {
      baseUrl: "http://127.0.0.1:14318/v1",
      apiProtocol: "responses",
      model: "test",
      apiKey: "team-fixture",
      systemPrompt: "",
      expectedRevision: config.revision,
    },
  });
  const before = await (await request.get("/api/v1/sessions")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "开启新对话" }).click();
  await page.getByRole("textbox", { name: "输入消息" }).fill("团队产品验收");
  await page.getByRole("button", { name: "发送消息" }).click();
  const panel = page.locator(".team-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("核验成员");
  const rail = page.getByRole("complementary", { name: "团队侧栏" });
  const mainBox = await page.locator("main").boundingBox();
  const railBox = await rail.boundingBox();
  expect(railBox?.x).toBeGreaterThanOrEqual(
    (mainBox?.x ?? 0) + (mainBox?.width ?? 0) - 1,
  );
  await page.getByRole("textbox", { name: "输入消息" }).fill("下一步草稿");
  await rail.getByRole("button", { name: "关闭团队侧栏" }).click();
  await expect(rail).toHaveCount(0);
  await page.getByRole("button", { name: "切换团队侧栏" }).click();
  await expect(panel).toContainText("核验成员");
  await expect(page.getByRole("textbox", { name: "输入消息" })).toHaveValue(
    "下一步草稿",
  );
  await panel.getByRole("button", { name: "查看过程" }).click();
  await expect(panel.getByRole("button", { name: "批准并继续" })).toBeVisible();
  await page.reload();
  await panel.getByRole("button", { name: "查看过程" }).click();
  await panel.getByRole("button", { name: "批准并继续" }).click();
  await expect(page.locator(".message.assistant").last()).toContainText(
    "团队产品验收已完成",
  );
  const sessionId = new URL(page.url()).searchParams.get("session");
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/v1/sessions/${sessionId}`)).json())
          .activeRun,
    )
    .toBeNull();
  const after = await (await request.get("/api/v1/sessions")).json();
  expect(after.sessions.length).toBe(before.sessions.length + 1);
  await page.reload();
  await expect(panel).toBeVisible();
  if ((await panel.getAttribute("open")) === null)
    await panel.locator(":scope > summary").click();
  await expect(panel).toContainText("核验成员");
  await panel.getByRole("button", { name: "查看过程" }).click();
  await expect(
    panel.getByText("成员完成真实命令核验。", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: ".cache/acceptance/teams-chat.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await rail.evaluate(
      (node) => node.getBoundingClientRect().right <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".cache/acceptance/teams-mobile.png" });
  await rail.getByRole("button", { name: "关闭团队侧栏" }).click();
  await expect(
    page.getByRole("textbox", { name: "输入消息" }),
  ).toBeInViewport();
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole("button", { name: "切换团队侧栏" }).click();
  await panel.getByRole("button", { name: "关闭成员" }).click();
  await expect(panel).toContainText("已关闭");
  await page.screenshot({ path: ".cache/acceptance/teams-closed.png" });
});
