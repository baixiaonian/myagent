/** 文档工作区产品验收：临时真实项目与协议替身覆盖链接、编辑、保存冲突、选段对话、HTML 隔离和窄屏。 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

let workspacePath: string;
test.beforeEach(async ({ page, request }) => {
  workspacePath = JSON.parse(
    readFileSync(".cache/execution-e2e.json", "utf8"),
  ).workspacePath;
  writeFileSync(
    join(workspacePath, "output/article.md"),
    "# 工作区文档\n\n这段文字可以选中编辑。\n\n## 核心结论\n\n保留原有内容，记录每次修改。\n\n| 项目 | 状态 |\n| --- | --- |\n| 编辑器 | 可用 |\n",
  );
  const settings = await (await request.get("/api/v1/settings")).json();
  await request.put("/api/v1/settings", {
    data: {
      baseUrl: "http://127.0.0.1:14318/v1",
      apiProtocol: "responses",
      model: "test",
      apiKey: "document-fixture",
      systemPrompt: "",
      expectedRevision: settings.revision,
    },
  });
  const session = await (
    await request.post("/api/v1/sessions", {
      data: { path: workspacePath, requestId: crypto.randomUUID() },
    })
  ).json();
  await page.goto(`/?session=${session.id}`);
  await page.getByRole("textbox", { name: "输入消息" }).fill("展示项目文档");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(
    page.getByRole("button", { name: "output/article.md", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "output/article.md", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "文档正文", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status", { name: "文档保存状态" })).toHaveText(
    "已保存",
  );
});
async function selectParagraph(page: import("@playwright/test").Page) {
  await page.locator(".tiptap > p").first().click({ clickCount: 3 });
  await expect(
    page.getByRole("button", { name: "添加到对话", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "编辑", exact: true }),
  ).toHaveCount(0);
}
test("聊天引用打开右栏，富文本格式与选段修改可保存，切换文件和收起保留草稿", async ({
  page,
}) => {
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "阅读", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "源码", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "项目文件目录" }),
  ).toBeVisible();
  await selectParagraph(page);
  await page.getByRole("button", { name: "加粗", exact: true }).click();
  await expect(page.locator(".tiptap > p strong").first()).toContainText(
    "这段文字",
  );
  await selectParagraph(page);
  await page.keyboard.insertText("这段内容已经局部更新。");
  await expect(page.getByRole("status", { name: "文档保存状态" })).toHaveText(
    "已保存",
  );
  expect(
    readFileSync(join(workspacePath, "output/article.md"), "utf8"),
  ).toContain("这段内容已经局部更新。");
  expect(
    readFileSync(join(workspacePath, "output/article.md"), "utf8"),
  ).toContain("保留原有内容");
  writeFileSync(
    join(workspacePath, "output/article.md"),
    readFileSync(join(workspacePath, "output/article.md"), "utf8") +
      "\n外部新增的进度。\n",
  );
  await page
    .getByRole("button", { name: "output/article.md", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "文档正文", exact: true }),
  ).toContainText("外部新增的进度。");
  await page
    .getByRole("textbox", { name: "文档正文", exact: true })
    .press("ControlOrMeta+End");
  await page.keyboard.type("临时编辑草稿");
  await page.getByRole("button", { name: "report.html", exact: true }).click();
  await expect(page.getByTitle("HTML 文档预览")).toBeVisible();
  await page.getByRole("tab", { name: "article.md" }).click();
  await expect(
    page.getByRole("textbox", { name: "文档正文", exact: true }),
  ).toContainText("临时编辑草稿");
  await page.getByRole("button", { name: "收起文档面板" }).click();
  await page.getByRole("button", { name: "打开项目文档" }).click();
  await expect(
    page.getByRole("textbox", { name: "文档正文", exact: true }),
  ).toContainText("临时编辑草稿");
  await page.screenshot({ path: ".cache/acceptance/document-rich-editor.png" });
});
test("选区加入聊天保留已有问题与文件版本，冲突展示双版本且不覆盖外部写入", async ({
  page,
}) => {
  const composer = page.getByRole("textbox", { name: "输入消息" });
  await composer.fill("我想确认一下：");
  await selectParagraph(page);
  await page.getByRole("button", { name: "添加到对话", exact: true }).click();
  await expect(composer).toHaveValue("我想确认一下：");
  await page.getByRole("button", { name: "1 个已选文本片段" }).click();
  await expect(
    page.getByRole("region", { name: "已选文本片段" }),
  ).toContainText("这段文字可以选中编辑");
  await expect(
    page.getByRole("region", { name: "已选文本片段" }),
  ).toContainText("output/article.md");
  await page.getByRole("button", { name: "1 个已选文本片段" }).click();
  await selectParagraph(page);
  await page.keyboard.insertText("我的草稿");
  writeFileSync(
    join(workspacePath, "output/article.md"),
    "# 外部刚刚更新\n\nAgent 写入的内容。\n",
  );
  await expect(page.getByText("磁盘有更新，自动保存已暂停")).toBeVisible();
  expect(
    readFileSync(join(workspacePath, "output/article.md"), "utf8"),
  ).toContain("Agent 写入的内容");
  await page.getByText("比较磁盘版本和我的修改", { exact: true }).click();
  await expect(page.locator(".document-compare")).toContainText("我的草稿");
  await expect(page.locator(".document-compare")).toContainText(
    "Agent 写入的内容",
  );
  await page.screenshot({ path: ".cache/acceptance/document-conflict.png" });
  await page.getByRole("button", { name: "使用我的版本", exact: true }).click();
  await expect(page.getByRole("status", { name: "文档保存状态" })).toHaveText(
    "已保存",
  );
  expect(
    readFileSync(join(workspacePath, "output/article.md"), "utf8"),
  ).toContain("我的草稿");
});
test("HTML 文字编辑保持 head 和脚本源文，编辑时不能执行文件脚本；扩展 Markdown 不丢语法", async ({
  page,
}) => {
  const original = readFileSync(
    join(workspacePath, "output/report.html"),
    "utf8",
  );
  let unsafe = false;
  const networkProbes: string[] = [];
  // request 事件也报告被 CSP 拒绝的尝试；路由拦截核验真正走到网络层的请求。
  await page.route("**/document-network-probe**", async (route) => {
    networkProbes.push(route.request().url());
    await route.fulfill({ status: 200, body: "network escaped" });
  });
  await page.exposeFunction("unsafeDocumentScript", () => {
    unsafe = true;
  });
  await page.evaluate(() =>
    window.addEventListener("message", (e) => {
      if (e.data === "UNSAFE_SCRIPT")
        void (
          window as unknown as { unsafeDocumentScript: () => Promise<void> }
        ).unsafeDocumentScript();
    }),
  );
  await page.getByRole("button", { name: "report.html", exact: true }).click();
  await page.getByRole("button", { name: "文字编辑", exact: true }).click();
  const frame = page.frameLocator('iframe[title="HTML 文档预览"]');
  await expect(frame.locator("body")).not.toHaveAttribute(
    "data-original-script",
    "executed",
  );
  await expect(
    frame.getByRole("heading", { name: "文档工作区" }),
  ).toBeVisible();
  await frame.locator("p span").evaluate((node) => {
    const r = document.createRange();
    r.selectNodeContents(node);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await expect(
    page.getByRole("button", { name: "编辑", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "HTML 选段加粗", exact: true })
    .click();
  await expect(frame.locator("p strong")).toContainText(
    "选择这段内容进行编辑 & 提问。",
  );
  await expect(page.getByRole("status", { name: "文档保存状态" })).toHaveText(
    "已保存",
  );
  const updated = readFileSync(
    join(workspacePath, "output/report.html"),
    "utf8",
  );
  expect(updated).toBe(
    original.replace(
      "选择这段内容进行编辑 &amp; 提问。",
      "<strong>选择这段内容进行编辑 &amp; 提问。</strong>",
    ),
  );
  expect(unsafe).toBe(false);
  expect(networkProbes).toEqual([]);
  await page.getByRole("button", { name: "advanced.md", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "文档正文", exact: true }),
  ).toContainText("title: 保留元数据");
  await page
    .getByRole("textbox", { name: "文档正文", exact: true })
    .press("ControlOrMeta+End");
  await page.keyboard.type("补充内容");
  await expect
    .poll(() => readFileSync(join(workspacePath, "output/advanced.md"), "utf8"))
    .toContain("补充内容");
  await expect(page.getByRole("status", { name: "文档保存状态" })).toHaveText(
    "已保存",
  );
  expect(
    readFileSync(join(workspacePath, "output/advanced.md"), "utf8"),
  ).toContain("<!-- 不可丢失的注释 -->");
});
test("手机文档面板可编辑、切换目录与返回聊天，没有横向溢出", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "切换项目目录" }).click();
  await expect(
    page.getByRole("navigation", { name: "项目文件目录" }),
  ).not.toBeVisible();
  await selectParagraph(page);
  await page.getByRole("button", { name: "添加到对话", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "文档工作区" }),
  ).not.toBeVisible();
  await expect(page.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "1 个已选文本片段" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开项目文档" }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".cache/acceptance/document-mobile.png" });
});

test("选区浮层紧邻正文，片段芯片可展开移除，发送才携带文本上下文", async ({
  page,
  request,
}) => {
  const composer = page.getByRole("textbox", { name: "输入消息" });
  await composer.fill("请解释这个片段");
  await selectParagraph(page);
  const position = await page.locator(".selection-popover").boundingBox();
  const paragraph = await page.locator(".tiptap > p").first().boundingBox();
  expect(position).not.toBeNull();
  expect(paragraph).not.toBeNull();
  expect(
    Math.abs(
      (position?.y ?? 0) - ((paragraph?.y ?? 0) + (paragraph?.height ?? 0)),
    ),
  ).toBeLessThan(60);
  await page.screenshot({
    path: ".cache/acceptance/document-v2-selection.png",
  });
  await page.getByRole("button", { name: "添加到对话", exact: true }).click();
  await expect(composer).toHaveValue("请解释这个片段");
  await page.getByRole("button", { name: "1 个已选文本片段" }).click();
  await page
    .getByRole("button", { name: "移除片段 output/article.md" })
    .click();
  await expect(
    page.getByRole("button", { name: "1 个已选文本片段" }),
  ).toHaveCount(0);
  await selectParagraph(page);
  await page.getByRole("button", { name: "添加到对话", exact: true }).click();
  await page.screenshot({ path: ".cache/acceptance/document-v2-chip.png" });
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "1 个已选文本片段" }),
  ).toHaveCount(0);
  await expect(composer).toHaveValue("");
  const id = new URL(page.url()).searchParams.get("session");
  const snapshot = await (await request.get(`/api/v1/sessions/${id}`)).json();
  const message = snapshot.messages
    .filter((m: { role: string }) => m.role === "user")
    .at(-1);
  expect(message.content).toContain("请解释这个片段");
  expect(message.content).toContain("引用文档：output/article.md");
  expect(message.content).toContain("这段文字可以选中编辑");
});

test("自动保存串行提交，保存期间输入、收起面板与切换项目不丢修改", async ({
  page,
}) => {
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const writes: { content: string; expectedRevision: string }[] = [];
  await page.route("**/api/v1/projects/*/document", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) await gate;
    await route.continue();
  });
  const editor = page.getByRole("textbox", { name: "文档正文", exact: true });
  await editor.press("ControlOrMeta+End");
  await page.keyboard.type("第一段");
  await expect.poll(() => writes.length).toBe(1);
  await page.keyboard.type("第二段");
  await page.getByRole("button", { name: "收起文档面板" }).click();
  await page.getByRole("button", { name: "开启新对话", exact: true }).click();
  release();
  await expect
    .poll(() => readFileSync(join(workspacePath, "output/article.md"), "utf8"))
    .toContain("第一段第二段");
  expect(writes).toHaveLength(2);
  expect(writes[0]?.expectedRevision).not.toBe(writes[1]?.expectedRevision);
});

test("自动保存失败保留正文且不循环重试，用户重试成功后关闭标签会刷新最后输入", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/v1/projects/*/document", async (route) => {
    if (route.request().method() === "PUT") {
      attempts++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "test_unavailable", message: "临时无法保存" },
        }),
      });
    } else await route.continue();
  });
  const editor = page.getByRole("textbox", { name: "文档正文", exact: true });
  await editor.press("ControlOrMeta+End");
  await page.keyboard.type("未提交版本");
  await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
  await page.keyboard.type("继续保留");
  await page.getByRole("button", { name: "关闭 output/article.md" }).click();
  await expect(page.getByRole("tab", { name: /article.md/ })).toBeVisible();
  expect(attempts).toBe(1);
  await page.unroute("**/api/v1/projects/*/document");
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByRole("status", { name: "文档保存状态" })).toHaveText(
    "已保存",
  );
  await editor.press("ControlOrMeta+End");
  await page.keyboard.type("关闭前输入");
  await page.getByRole("button", { name: "关闭 output/article.md" }).click();
  await expect(page.getByRole("tab", { name: /article.md/ })).toHaveCount(0);
  expect(
    readFileSync(join(workspacePath, "output/article.md"), "utf8"),
  ).toContain("关闭前输入");
});

test("阅读和选中不触发写入，中文组合输入完成后才自动保存，Markdown 输入实时成为标题", async ({
  page,
}) => {
  const original = readFileSync(
    join(workspacePath, "output/article.md"),
    "utf8",
  );
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/document"))
      writes++;
  });
  await selectParagraph(page);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "选中文本操作" })).toHaveCount(
    0,
  );
  await selectParagraph(page);
  await page.keyboard.press("Escape");
  // 跨过防抖窗口，确认只阅读/选中不会规范化并写回原文件。
  await page.waitForTimeout(850);
  expect(writes).toBe(0);
  expect(readFileSync(join(workspacePath, "output/article.md"), "utf8")).toBe(
    original,
  );
  const editor = page.getByRole("textbox", { name: "文档正文", exact: true });
  await page.locator(".tiptap > p").first().click();
  await page.keyboard.press("End");
  await editor.dispatchEvent("compositionstart");
  await page.keyboard.insertText("正在输入中文");
  await page.waitForTimeout(850);
  expect(writes).toBe(0);
  await editor.dispatchEvent("compositionend");
  await expect(page.getByRole("status", { name: "文档保存状态" })).toHaveText(
    "已保存",
  );
  expect(
    readFileSync(join(workspacePath, "output/article.md"), "utf8"),
  ).toContain("正在输入中文");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## 实时标题");
  await expect(
    page.locator(".tiptap h2").filter({ hasText: "实时标题" }),
  ).toBeVisible();
  await expect
    .poll(() => readFileSync(join(workspacePath, "output/article.md"), "utf8"))
    .toContain("## 实时标题");
});

test("刷新读取期间继续输入，迟到的磁盘响应不能覆盖新草稿", async ({ page }) => {
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let reading = false;
  await page.route("**/api/v1/projects/*/document?*", async (route) => {
    const response = await route.fetch();
    reading = true;
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "重新载入文档" }).click();
  await expect.poll(() => reading).toBe(true);
  await page
    .getByRole("textbox", { name: "文档正文", exact: true })
    .press("ControlOrMeta+End");
  await page.keyboard.type("刷新过程中继续编辑");
  release();
  await expect(
    page.getByText("读取期间文档已修改，已保留当前编辑。"),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "文档正文", exact: true }),
  ).toContainText("刷新过程中继续编辑");
  await expect
    .poll(() => readFileSync(join(workspacePath, "output/article.md"), "utf8"))
    .toContain("刷新过程中继续编辑");
});

// 验证产品实际 iframe，而非独立打开 HTML：脚本生成的节点、交互、隔离及源码保存边界必须同时成立。
test("HTML 默认运行内嵌报表脚本与筛选，运行态不写回文件且不能访问宿主或网络", async ({
  page,
}) => {
  const file = join(workspacePath, "output/dynamic.html");
  const original = readFileSync(file, "utf8");
  const escapedRequests: string[] = [];
  await page.route("**/document-network-probe**", async (route) => {
    escapedRequests.push(route.request().url());
    await route.fulfill({ status: 200, body: "network escaped" });
  });
  await page.getByRole("button", { name: "dynamic.html", exact: true }).click();
  const outer = page.frameLocator('iframe[title="HTML 文档预览"]');
  const frame = outer.frameLocator('iframe[title="HTML 交互内容"]');
  await expect(frame.locator("#total")).toHaveText("700");
  await expect(frame.locator("#rows tr")).toHaveCount(3);
  await frame.getByRole("combobox", { name: "月份" }).selectOption("一月");
  await expect(frame.locator("#total")).toHaveText("300");
  await expect(frame.locator("#rows tr")).toHaveCount(2);
  await frame.getByRole("button", { name: "内联事件" }).click();
  await expect(frame.locator("#clicked")).toHaveText("已交互");
  await expect(frame.locator("#parent-state")).toHaveText("宿主隔离");
  await frame.getByRole("button", { name: "检查网络" }).click();
  await expect(frame.locator("#network-state")).toHaveText("网络阻止");
  await frame.getByRole("button", { name: "伪造编辑消息" }).click();
  await expect(
    page.getByRole("button", { name: "添加到对话", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "HTML 选段加粗" })).toHaveCount(
    0,
  );
  await frame.getByRole("button", { name: "打开弹窗" }).click();
  expect(page.context().pages()).toHaveLength(1);
  expect(escapedRequests).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe(original);
  await page.getByRole("button", { name: "文字编辑", exact: true }).click();
  await expect(outer.locator("#total")).toHaveText("–");
  await expect(outer.locator("#rows tr")).toHaveCount(0);
  await page.getByRole("button", { name: "交互预览", exact: true }).click();
  await expect(frame.locator("#total")).toHaveText("700");
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.getByRole("combobox", { name: "月份" }).selectOption("二月");
  await expect(frame.locator("#total")).toHaveText("400");
  await expect(frame.locator("#rows tr")).toHaveCount(1);
  await page.screenshot({
    path: ".cache/acceptance/document-interactive-mobile.png",
  });
  // sandbox 本身允许子页面导航自身；可信外层的 frame-src 必须再拦住这一出口。
  await frame.getByRole("button", { name: "跳转接口" }).click();
  await expect
    .poll(() => page.frames().some((f) => f.url().startsWith("chrome-error:")))
    .toBe(true);
  expect(escapedRequests).toEqual([]);
  expect(new URL(page.url()).origin).toBe("http://127.0.0.1:14317");
  expect(readFileSync(file, "utf8")).toBe(original);
});
