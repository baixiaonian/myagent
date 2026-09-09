/**
 * Web 产品流程验收：用浏览器验证配置、会话、多轮、Markdown、停止、刷新与输入法交互。
 * 同时覆盖草稿、模糊提交结果和阅读时暂停追尾；只操作专用测试实例与假模型。
 */
import { expect, type Page, test } from "@playwright/test";

async function configure(page: Page, model = "test") {
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page
    .getByLabel("接口基础地址", { exact: true })
    .fill("http://127.0.0.1:14318/v1");
  await page.getByLabel("模型 ID", { exact: true }).fill(model);
  await page.getByLabel("API 密钥", { exact: true }).fill("sk-e2e-fake-only");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(
    page.getByText("配置已保存，下次生成将使用新设置。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭弹窗" }).click();
}
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "输入消息" }).fill(text);
  await page.getByRole("button", { name: "发送消息" }).click();
}
// 同时等待生成按钮消失和最终答案复制入口，避免只凭网络空闲判断流式回答结束。
async function finished(page: Page) {
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect(
    page
      .getByRole("article", { name: "模型回答" })
      .last()
      .getByRole("button", { name: "复制消息" }),
  ).toBeVisible();
}
// 每例先清理专用实例的配置和会话，首次引导与会话断言不依赖前一例留下的状态。
test.beforeEach(async ({ request }) => {
  const current = (await (await request.get("/api/v1/settings")).json()) as {
    revision: number;
  };
  await request.put("/api/v1/settings", {
    data: {
      baseUrl: "http://127.0.0.1:14318/v1",
      model: "test",
      systemPrompt: "",
      clearKey: true,
      expectedRevision: current.revision,
    },
  });
  const data = (await (await request.get("/api/v1/sessions")).json()) as {
    sessions: { id: string }[];
  };
  for (const session of data.sessions)
    await request.delete(`/api/v1/sessions/${session.id}`);
});
test("first use, connection test, Markdown, multiround, regenerate, rename, refresh and delete", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page.getByRole("dialog", { name: "模型设置" })).toBeVisible();
  await page
    .getByLabel("接口基础地址", { exact: true })
    .fill("http://127.0.0.1:14318/v1");
  await page.getByLabel("模型 ID", { exact: true }).fill("test");
  await page.getByLabel("API 密钥", { exact: true }).fill("sk-e2e-fake-only");
  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByText("连接成功，模型已返回文字响应。")).toBeVisible();
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByLabel("API 密钥", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await send(page, "展示 Markdown");
  await finished(page);
  await expect(page.locator(".markdown table")).toBeVisible();
  await expect(page.locator(".markdown .hljs-keyword").first()).toBeVisible();
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
  await expect(page.locator(".markdown img,.markdown script")).toHaveCount(0);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "复制代码" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "const hello",
  );
  await send(page, "继续解释");
  await finished(page);
  await expect(
    page.getByRole("article", { name: "模型回答" }).last(),
  ).toContainText("第 2 轮");
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await finished(page);
  await expect(page.getByRole("article", { name: "你的消息" })).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole("article", { name: "你的消息" })).toHaveCount(2);
  await page.getByRole("button", { name: "重命名：展示 Markdown" }).click();
  await page.getByLabel("对话标题").fill("我的笔记");
  await page.getByRole("button", { name: "保存名称" }).click();
  await expect(
    page.getByRole("button", { name: "我的笔记", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "开启新对话" }).click();
  await expect(
    page.getByRole("heading", { name: "今天，想聊点什么？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "我的笔记", exact: true }).click();
  await expect(page.getByRole("article", { name: "你的消息" })).toHaveCount(2);
  await page.getByRole("button", { name: "删除：我的笔记" }).click();
  await page.getByRole("button", { name: "删除对话", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "我的笔记", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("sk-e2e-fake-only");
});
test("refresh during generation, draft preservation, IME Enter, stop and failed regeneration", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await configure(page, "slow");
  const input = page.getByRole("textbox", { name: "输入消息" });
  await input.fill("你好");
  // 人工触发输入法组合事件后按 Enter，验证候选确认不会提交问题；随后再验收正常换行。
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  await expect(page.getByRole("article", { name: "你的消息" })).toHaveCount(0);
  await input.dispatchEvent("compositionend");
  await input.fill("你好");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("你好\n");
  await send(page, "请慢速回答一个较长问题，以便测试刷新和中止");
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await expect(
    page.getByRole("article", { name: "模型回答" }).last(),
  ).toContainText("收到");
  await input.fill("下一个问题草稿");
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByText("已停止生成", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("下一个问题草稿");
  await configure(page);
  await input.fill("成功回答");
  await input.press("Enter");
  await expect(
    page.getByRole("article", { name: "模型回答" }).last(),
  ).toContainText("收到：成功回答");
  await finished(page);
  const previous = await page
    .locator(".message.assistant .markdown")
    .last()
    .innerText();
  await configure(page, "unauthorized");
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试回答" })).toBeVisible();
  await expect(
    page.getByRole("article", { name: "模型回答" }).last(),
  ).toContainText(previous);
});
test("mobile drawer and configuration clear", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.getByRole("button", { name: "打开会话列表" }).click();
  await configure(page);
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await send(page, "手机聊天");
  await finished(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "打开会话列表" }).click();
  await expect(
    page.getByRole("button", { name: "手机聊天", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByRole("button", { name: "清除已保存的密钥" }).click();
  await expect(page.getByText("已清除本机保存的密钥。")).toBeVisible();
});

test("ambiguous POST response reuses request ID and keeps unsent draft", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await configure(page);
  await page.route(
    "**/api/v1/sessions/*/runs",
    async (route) => {
      // 先让请求真实到达服务端并落库，再丢弃浏览器响应，制造“执行成功但客户端不知道”的情形。
      await route.fetch();
      await route.abort("failed");
    },
    { times: 1 },
  );
  await send(page, "测试网络恢复");
  await expect(page.getByRole("article", { name: "你的消息" })).toHaveCount(1);
  await finished(page);
  await expect(page.getByRole("textbox", { name: "输入消息" })).toHaveValue(
    "测试网络恢复",
  );
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
  await expect(page.getByRole("article", { name: "你的消息" })).toHaveCount(1);
});

test("reading above streamed content suspends auto-scroll and offers return to bottom", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await configure(page);
  await send(page, "请展示长文 Markdown");
  await expect(page.locator(".markdown table")).not.toHaveCount(0);
  await page.locator(".conversation").hover();
  // 通过真实滚轮切换到主动阅读状态，验证新文字到达后不会把页面强拉到底部。
  await page.mouse.wheel(0, -5000);
  await expect(page.getByRole("button", { name: "回到底部" })).toBeVisible();
  await expect(
    page
      .getByRole("article", { name: "模型回答" })
      .getByRole("button", { name: "复制消息" }),
  ).toBeVisible();
  const top = await page
    .locator(".conversation")
    .evaluate((element) => element.scrollTop);
  expect(top).toBeLessThan(100);
  await page.getByRole("button", { name: "回到底部" }).click();
  await expect(page.getByRole("button", { name: "回到底部" })).toHaveCount(0);
});
