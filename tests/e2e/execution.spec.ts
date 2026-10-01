/**
 * 工具产品端到端验证：浏览器绑定目录、配置真实 HTTP MCP 替身、审批、分页、撤销和重跑。
 * 模型只按固定测试脚本发工具指令；此测试验证产品闭环，不代表真实模型自主选择能力。
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const fixture = () =>
  JSON.parse(readFileSync(".cache/execution-e2e.json", "utf8")) as {
    workspacePath: string;
    outsidePath: string;
    mcpUrl: string;
  };

// 使用专属测试目录与真实会话接口验收项目树；不写入用户数据，不请求模型。
test("会话归入项目，折叠刷新后仍可定位，项目新建保留草稿且不创建空会话", async ({
  page,
  request,
}) => {
  const root = mkdtempSync(join(fixture().workspacePath, "navigation-"));
  const paths = [join(root, "alpha"), join(root, "beta")];
  for (const path of paths) mkdirSync(path);
  try {
    const created: { id: string; title: string }[] = [];
    for (const [index, path] of [
      paths[0],
      paths[0],
      paths[1],
      undefined,
    ].entries()) {
      const response = await request.post("/api/v1/sessions", {
        data: { requestId: crypto.randomUUID(), ...(path ? { path } : {}) },
      });
      expect(response.ok()).toBe(true);
      const record = await response.json();
      const title = `分组对话${index}`;
      const renamed = await request.patch(`/api/v1/sessions/${record.id}`, {
        data: { title, expectedRevision: record.revision },
      });
      expect(renamed.ok()).toBe(true);
      created.push({ id: record.id, title });
    }
    await page.goto(`/?session=${created[0]?.id}`);
    const alpha = page.getByRole("region", {
      name: "项目：alpha",
      exact: true,
    });
    const beta = page.getByRole("region", { name: "项目：beta", exact: true });
    const independent = page.getByRole("region", {
      name: "项目：独立对话",
      exact: true,
    });
    await expect(alpha.locator(".session-row")).toHaveCount(2);
    await expect(
      beta.getByRole("button", { name: "分组对话2", exact: true }),
    ).toBeVisible();
    await expect(
      independent.getByRole("button", { name: "分组对话3", exact: true }),
    ).toBeVisible();
    await expect(
      alpha.getByRole("button", { name: "分组对话2", exact: true }),
    ).toHaveCount(0);
    await alpha.locator(".project-toggle").click();
    await expect(alpha.locator(".session-row")).toHaveCount(0);
    await page.reload();
    await expect(
      alpha.getByRole("button", { name: "分组对话0", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "开启新对话" }).click();
    const draft = page.getByRole("textbox", { name: "输入消息" });
    await draft.fill("项目切换保留草稿");
    await beta.getByRole("button", { name: "在beta中新建对话" }).click();
    await expect(
      page.getByRole("button", { name: "选择项目", exact: true }),
    ).toContainText("beta");
    await expect(draft).toHaveValue("项目切换保留草稿");
    expect(
      (await (await request.get("/api/v1/sessions")).json()).sessions,
    ).toHaveLength(4);
  } finally {
    // 只删除本例 mkdtemp 分配的文件；会话与工作区数据库由隔离测试服务统一清理。
    rmSync(root, { recursive: true, force: true });
  }
});
async function workspace(page: Page) {
  await page.goto("/");
  if (await page.getByRole("dialog", { name: "模型设置" }).isVisible())
    await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.getByRole("button", { name: "选择项目", exact: true }).click();
  await page.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "选择项目", exact: true }),
  ).toHaveCount(0);
}
async function send(page: Page, content: string) {
  await page.getByRole("textbox", { name: "输入消息" }).fill(content);
  await page.getByRole("button", { name: "发送消息" }).click();
}
test.beforeEach(async ({ request }) => {
  const settings = await (await request.get("/api/v1/settings")).json();
  await request.put("/api/v1/settings", {
    data: {
      baseUrl: "http://127.0.0.1:14318/v1",
      model: "test",
      systemPrompt: "",
      apiKey: "fixture-e2e-tools",
      apiProtocol: "responses",
      expectedRevision: settings.revision,
    },
  });
  const commandConfig = await (
    await request.get("/api/v1/command-policy/config?scope=user")
  ).json();
  await request.put("/api/v1/command-policy/config", {
    data: {
      scope: "user",
      expectedRevision: commandConfig.revision,
      text: '{"schemaVersion":1,"rules":[]}',
    },
  });
  const sessions = await (await request.get("/api/v1/sessions")).json();
  for (const session of sessions.sessions)
    await request.delete(`/api/v1/sessions/${session.id}`);
  const connections = await (
    await request.get("/api/v1/mcp/connections")
  ).json();
  for (const connection of connections.connections)
    await request.delete(`/api/v1/mcp/connections/${connection.id}`);
});
test("绑定工作区、刷新审批并拒绝，回传错误后模型继续", async ({ page }) => {
  await workspace(page);
  await send(page, "查看外部说明，并告诉我结果");
  await expect(page.getByText("需要你批准这次操作")).toBeVisible();
  await expect(page.locator(".composer-area .approval-card")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "批准并继续" }),
  ).toBeInViewport();
  await page.screenshot({ path: ".cache/acceptance/workbench-approval.png" });
  await page.reload();
  await expect(page.getByText("需要你批准这次操作")).toBeVisible();
  await page.getByRole("button", { name: "拒绝操作", exact: true }).click();
  await expect(page.locator(".markdown").last()).toContainText(
    "外部说明请求已处理。",
  );
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await page.screenshot({
    path: ".cache/tool-execution/web-approval.png",
    fullPage: true,
  });
});
test("MCP 配置、按需发现、批准、完整结果分页、重跑确认和授权撤销", async ({
  page,
  request,
}) => {
  await workspace(page);
  await page.getByRole("button", { name: "MCP 服务", exact: true }).click();
  await page.getByRole("button", { name: "＋ 添加 MCP", exact: true }).click();
  await page.getByLabel("服务名称", { exact: true }).fill("测试回声服务");
  await page.getByLabel("服务地址", { exact: true }).fill(fixture().mcpUrl);
  await page
    .getByRole("button", { name: "确认转换并保存连接", exact: true })
    .click();
  await expect(page.locator(".mcp-state.connected")).toBeVisible();
  await page.locator(".mcp-server > summary").click();
  await expect(page.locator(".mcp-tool").first()).toContainText("echo");
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await send(page, "把这些文字转交回声服务，然后给我结果");
  await expect(page.getByText("需要你批准这次操作")).toBeVisible();
  await page.getByLabel("授权期限").selectOption("workspace");
  await page.getByRole("button", { name: "批准并继续" }).click();
  await expect(page.locator(".markdown").last()).toContainText(
    "回声服务已返回结果。",
  );
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await page.locator(".run-process > summary").last().click();
  await page.locator(".tool-batch > summary").last().click();
  await page.locator(".tool-call summary").last().click();
  await page
    .getByRole("button", { name: "查看保存的结果", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("dialog", { name: "工具执行结果" }),
  ).toContainText("中文回声");
  const before = (await page.locator(".full-result").innerText()).length;
  await page.getByRole("button", { name: "加载下一页" }).click();
  await expect
    .poll(async () => (await page.locator(".full-result").innerText()).length)
    .toBeGreaterThan(before);
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  // 刷新后继续同一会话，执行过程应只剩真实调用；目录加载状态由服务端恢复。
  await page.reload();
  await send(page, "再把这些文字转交回声服务，然后给我结果");
  await expect(page.getByText("执行记录 · 1 次工具调用")).toBeVisible();
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  const sessionId = new URL(page.url()).searchParams.get("session");
  const snapshot = await (
    await request.get(`/api/v1/sessions/${sessionId}`)
  ).json();
  const tools = snapshot.steps
    .filter((step: { runId: string }) => step.runId === snapshot.latestRun.id)
    .flatMap((step: { tools: { name: string }[] }) => step.tools);
  expect(snapshot.latestRun.status).toBe("succeeded");
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toMatch(/^mcp_/);
  await page
    .getByRole("button", { name: "重新运行任务", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("dialog", { name: "重新运行任务" }),
  ).toContainText("原来的修改不会自动撤销");
  await page.getByRole("button", { name: "确认重新运行" }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await page.locator(".project-selector").click();
  await page
    .getByRole("button", { name: "撤销授权", exact: true })
    .first()
    .click();
  await page.screenshot({
    path: ".cache/tool-execution/web-tools-settings.png",
    fullPage: true,
  });
});

// 取消远端等待不能证明服务没执行；用户核对后才恢复同一 Run。
test("远端超时呈现未知结果，保存人工核对后手动继续", async ({
  page,
  request,
}) => {
  await workspace(page);
  const workspaces = await (await request.get("/api/v1/workspaces")).json();
  const selected = workspaces.workspaces.find(
    (item: { path: string }) => item.path === fixture().workspacePath,
  );
  const connection = await (
    await request.post("/api/v1/mcp/connections", {
      data: {
        name: "未知结果测试",
        transport: "http",
        url: fixture().mcpUrl,
        auth: "none",
        workspaceIds: [selected.id],
      },
    })
  ).json();
  await request.post(`/api/v1/mcp/connections/${connection.id}/connect`, {
    data: { workspaceId: selected.id },
  });
  await send(page, "转交回声服务，让服务超时");
  await expect(page.getByText("需要你批准这次操作")).toBeVisible();
  await page.getByRole("button", { name: "批准并继续" }).click();
  await expect(
    page.getByText("执行结果需要核对", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "记录核对结论" }).click();
  await page
    .getByLabel("核对说明")
    .fill("已检查测试服务；保留未知状态，接受风险后继续。");
  await page.getByRole("button", { name: "保存核对记录" }).click();
  await page.getByRole("button", { name: "继续运行", exact: true }).click();
  await expect(page.locator(".markdown").last()).toContainText(
    "回声服务已返回结果。",
  );
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
});

// 新入口必须消除空会话，并在实际发送时才分配默认目录。
test("独立 MCP 设置不创建会话，默认目录随会话隔离且刷新保留", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "MCP 服务", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "MCP 服务" })).toBeVisible();
  await expect(
    page.getByText("连接检测目录（无会话）", { exact: true }),
  ).toBeAttached();
  expect(
    (await (await request.get("/api/v1/sessions")).json()).sessions,
  ).toHaveLength(0);
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await send(page, "默认目录测试一");
  await expect(page).toHaveURL(/session=/);
  await expect(page.locator(".markdown").last()).toBeVisible();
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/v1/sessions")).json()).sessions.length,
    )
    .toBe(1);
  const first = (await (await request.get("/api/v1/sessions")).json())
    .sessions[0];
  expect(first.workspaceId).toBeTruthy();
  await page.reload();
  await page.locator(".project-selector").click();
  await expect(page.getByRole("dialog", { name: "项目与授权" })).toContainText(
    "默认项目",
  );
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.getByRole("button", { name: "开启新对话", exact: true }).click();
  await send(page, "默认目录测试二");
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/v1/sessions")).json()).sessions.length,
    )
    .toBe(2);
  const rows = (await (await request.get("/api/v1/sessions")).json()).sessions;
  expect(
    new Set(rows.map((s: { workspaceId: string }) => s.workspaceId)).size,
  ).toBe(2);
});
test("表单与 JSON 配置互相同步，启用与连接状态分开显示", async ({ page }) => {
  await workspace(page);
  await page.getByRole("button", { name: "MCP 服务", exact: true }).click();
  await page.getByRole("button", { name: "＋ 添加 MCP", exact: true }).click();
  await page.getByLabel("服务名称", { exact: true }).fill("json_echo");
  await page.getByLabel("服务地址", { exact: true }).fill(fixture().mcpUrl);
  await expect(
    page.getByRole("combobox", { name: "工具提供方式", exact: true }),
  ).toHaveValue("deferred");
  await page
    .getByRole("combobox", { name: "工具提供方式", exact: true })
    .selectOption("direct");
  await page.getByRole("button", { name: "确认转换并保存连接" }).click();
  await expect(page.locator(".mcp-state.connected")).toBeVisible();
  await page.getByRole("button", { name: "用户级", exact: true }).click();
  await page.locator(".mcp-config-source > summary").click();
  await page.getByRole("button", { name: "编辑配置文件", exact: true }).click();
  const textarea = page.getByLabel("配置 JSON", { exact: true });
  const document = JSON.parse(await textarea.inputValue());
  expect(document.mcpServers.json_echo.url).toBe(fixture().mcpUrl);
  expect(document.mcpServers.json_echo.toolExposure).toBe("direct");
  document.mcpServers.json_echo.toolExposure = "deferred";
  document.mcpServers.json_echo.enabled = false;
  await textarea.fill(JSON.stringify(document));
  await page.getByRole("button", { name: "确认转换并保存连接" }).click();
  await expect(page.locator(".mcp-state.disabled")).toHaveText("未启用");
  await page.getByLabel("启用 json_echo user").check();
  await expect(page.locator(".mcp-state.connected")).toBeVisible();
  await page.locator(".mcp-server > summary").click();
  await expect(page.locator(".mcp-tool")).toContainText("echo");
  await page.getByRole("button", { name: "编辑服务", exact: true }).click();
  await expect(page.getByLabel("服务地址", { exact: true })).toHaveValue(
    fixture().mcpUrl,
  );
  await expect(
    page.getByRole("combobox", { name: "工具提供方式", exact: true }),
  ).toHaveValue("deferred");
  await page
    .getByRole("combobox", { name: "工具提供方式", exact: true })
    .selectOption("direct");
  await page.getByRole("button", { name: "确认转换并保存连接" }).click();
  await page.reload();
  await page.getByRole("button", { name: "MCP 服务", exact: true }).click();
  await page.locator(".mcp-server > summary").click();
  await expect(
    page.getByText("工具提供方式：直接提供", { exact: true }),
  ).toBeVisible();
});

// 命令专用卡只提供一次批准；页面刷新后仍使用同一服务端审批，并向模型反馈拒绝。
test("命令审批刷新恢复、仅本次授权与拒绝反馈", async ({ page }) => {
  await workspace(page);
  await send(page, "命令权限验收：删除测试文件");
  await expect(page.getByText("需要你批准这次操作")).toBeVisible();
  await expect(page.locator(".command-approval")).toContainText(
    "rm command-fixture.txt",
  );
  await expect(page.getByLabel("授权期限")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".command-approval")).toContainText(
    "后续输入不再逐次审批",
  );
  await page.getByRole("button", { name: "拒绝操作", exact: true }).click();
  await expect(page.locator(".markdown").last()).toContainText(
    "命令请求已处理。",
  );
});

// 表单和 JSON 编辑器共用草稿；测试只读取规则并分析，不实际运行 rm。
test("命令规则设置、表单 JSON 同步、静态测试及独立入口", async ({
  page,
  request,
}) => {
  await workspace(page);
  await page.getByRole("button", { name: "命令权限", exact: true }).click();
  expect(
    (await (await request.get("/api/v1/sessions")).json()).sessions,
  ).toHaveLength(0);
  await expect(page.getByRole("dialog", { name: "命令权限" })).toBeVisible();
  await page.getByLabel("规则 ID", { exact: true }).fill("block-rm");
  await page
    .getByLabel("参数前缀（JSON 数组）", { exact: true })
    .fill('["rm"]');
  await page
    .getByRole("combobox", { name: "命令决策", exact: true })
    .selectOption("deny");
  await page.getByRole("button", { name: "加入规则草稿" }).click();
  await page.getByRole("button", { name: "JSON 编辑器", exact: true }).click();
  await expect(page.getByLabel("命令规则 JSON")).toHaveValue(/block-rm/);
  await page.getByRole("button", { name: "保存命令规则", exact: true }).click();
  await expect(
    page.getByText("命令规则已保存。", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "待检查命令", exact: true })
    .fill("rm fixture.txt");
  await page.getByRole("button", { name: "检查命令", exact: true }).click();
  await expect(page.locator(".command-assessment")).toContainText(
    "检查结果：拒绝",
  );
  await page
    .getByRole("textbox", { name: "待检查命令", exact: true })
    .fill("pwd");
  await page.getByRole("button", { name: "检查命令", exact: true }).click();
  await expect(page.locator(".command-assessment")).toContainText(
    "检查结果：允许",
  );
  await page.screenshot({
    path: ".cache/tool-execution/command-settings.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.getByRole("button", { name: "命令权限", exact: true }).click();
  await expect(page.locator(".command-rule")).toContainText("block-rm");
});

// 外部编辑只写本测试服务分配的项目；浏览器必须看见待确认版本，不能因文件落盘就信任。
test("项目规则外部变更确认、非法 JSON 修复与草稿保护", async ({ page }) => {
  await workspace(page);
  const directory = join(fixture().workspacePath, ".myagent");
  const path = join(directory, "command-rules.json");
  mkdirSync(directory, { recursive: true });
  try {
    await page.getByRole("button", { name: "命令权限", exact: true }).click();
    await page
      .getByRole("combobox", { name: "规则作用域", exact: true })
      .selectOption("project");
    await expect(
      page.getByRole("button", { name: "保存命令规则", exact: true }),
    ).toBeVisible();
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        rules: [{ id: "external-git", pattern: ["git"], decision: "allow" }],
      }),
    );
    await page.getByRole("button", { name: "加载新版本", exact: true }).click();
    await expect(
      page.getByText("项目规则待确认，新命令暂不可执行", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "确认当前文件版本", exact: true })
      .click();
    await expect(
      page.getByText("项目规则待确认，新命令暂不可执行", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "JSON 编辑器", exact: true })
      .click();
    const draft = '{"schemaVersion":1,"rules":[]}';
    await page
      .getByRole("textbox", { name: "命令规则 JSON", exact: true })
      .fill(draft);
    writeFileSync(path, '{"broken":');
    await expect(
      page.getByRole("button", { name: "加载新版本", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "命令规则 JSON", exact: true }),
    ).toHaveValue(draft);
    await expect(
      page.getByRole("button", { name: "保存命令规则", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "加载新版本", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("JSON 无效");
    await page
      .getByRole("textbox", { name: "命令规则 JSON", exact: true })
      .fill(draft);
    await page
      .getByRole("button", { name: "保存命令规则", exact: true })
      .click();
    await expect(
      page.getByText("命令规则已保存。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("项目规则待确认，新命令暂不可执行", { exact: true }),
    ).toHaveCount(0);
  } finally {
    rmSync(path, { force: true });
  }
});

// 项目选择是输入区内的轻量操作：不丢草稿、不创建空会话，失败仍可回退到原选择。
test("项目菜单搜索、Escape 和手动路径错误保留草稿，不创建空会话", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "输入消息" });
  await draft.fill("先保留这段草稿，选择项目后再发送");
  const selector = page.getByRole("button", { name: "选择项目", exact: true });
  await selector.click();
  const menu = page.getByRole("dialog", { name: "选择项目", exact: true });
  await expect(menu).toBeVisible();
  await menu
    .getByRole("textbox", { name: "搜索最近项目" })
    .fill("没有这个项目-unique");
  await expect(menu).toContainText("没有匹配的项目");
  await menu.getByRole("textbox", { name: "搜索最近项目" }).press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(selector).toBeFocused();
  await expect(draft).toHaveValue("先保留这段草稿，选择项目后再发送");
  await selector.click();
  await menu.getByRole("button", { name: "输入目录路径…" }).click();
  const manual = page.getByRole("dialog", {
    name: "选择本地目录",
    exact: true,
  });
  await manual
    .getByLabel("目录路径", { exact: true })
    .fill(`${fixture().workspacePath}/missing-project`);
  await manual.getByRole("button", { name: "使用此目录" }).click();
  await expect(manual.getByRole("alert")).toContainText("已经存在的目录");
  await manual.getByRole("button", { name: "关闭弹窗" }).click();
  await expect(draft).toHaveValue("先保留这段草稿，选择项目后再发送");
  await selector.click();
  await menu.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(selector).toContainText(
    fixture().workspacePath.split("/").at(-1) as string,
  );
  await selector.click();
  await menu.getByRole("button", { name: /使用默认目录/ }).click();
  await expect(selector).toContainText("选择项目");
  await page
    .getByRole("navigation", { name: "会话列表", exact: true })
    .getByRole("button", {
      name: `在${fixture().workspacePath.split("/").at(-1)}中新建对话`,
      exact: true,
    })
    .click();
  await expect(selector).toContainText(
    fixture().workspacePath.split("/").at(-1) as string,
  );
  await expect(draft).toHaveValue("先保留这段草稿，选择项目后再发送");
  expect(
    (await (await request.get("/api/v1/sessions")).json()).sessions,
  ).toHaveLength(0);
});

// 真实浏览器选择权限，真实 Worker 删除本例文件；模型替身仅负责提出已知工具调用。
test("完全访问选择不创建会话，刷新保留偏好；命令真实免审批，切回标准仍要求审批", async ({
  page,
  request,
}) => {
  await workspace(page);
  const mode = page.getByRole("combobox", { name: "执行权限" });
  await mode.selectOption("full_access");
  expect(
    (await (await request.get("/api/v1/sessions")).json()).sessions,
  ).toHaveLength(0);
  await page.reload();
  await expect(mode).toHaveValue("full_access");
  const path = join(fixture().workspacePath, "command-fixture.txt");
  writeFileSync(path, "delete only this fixture");
  // 项目选择是未发送草稿，刷新后重新选择，权限偏好独立保留。
  await workspace(page);
  await page.getByRole("textbox", { name: "输入消息" }).fill("命令权限验收");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByText("命令请求已处理。", { exact: true }),
  ).toBeVisible();
  const sessionId = new URL(page.url()).searchParams.get("session");
  const execution = await (
    await request.get(`/api/v1/sessions/${sessionId}/execution`)
  ).json();
  expect(execution.approvals).toHaveLength(0);
  expect(execution.invocations[0]).toMatchObject({
    executionMode: "full_access",
    status: "succeeded",
  });
  expect(() => readFileSync(path)).toThrow();
  await mode.selectOption("standard");
  writeFileSync(path, "retain before approval");
  await page
    .getByRole("textbox", { name: "输入消息" })
    .fill("命令权限验收，再运行");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(async () =>
      (
        await (
          await request.get(`/api/v1/sessions/${sessionId}/execution`)
        ).json()
      ).approvals.some((a: { status: string }) => a.status === "pending"),
    )
    .toBe(true);
  expect(readFileSync(path, "utf8")).toBe("retain before approval");
  await expect(mode).toBeDisabled();
  await expect(mode).toHaveValue("standard");
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
});
