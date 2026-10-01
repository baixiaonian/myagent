/**
 * MCP 工具提供方式集成验收：真实文件、SQLite、HTTP MCP 与应用执行器验证直接/按需混用。
 * 检查模型请求前的定义快照和真实派发边界；全部服务与目录为本测试创建，不使用真实模型。
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import {
  AGENT_LIMITS,
  type ApiProtocol,
  type McpConfigDocument,
  type McpConfigTarget,
  type Workspace,
} from "../../packages/contracts/src/index.js";
import { mockProvider } from "../chat/provider.js";
import { mcpFixture } from "./mcp-fixture.js";

let root: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let fixture: Awaited<ReturnType<typeof mcpFixture>>;
let provider: Awaited<ReturnType<typeof mockProvider>> | undefined;
let workspace: Workspace;
const options = () => ({
  dataDir: join(root, "data"),
  workspaceRoot: join(root, "defaults"),
  serveWeb: false,
});
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "myagent-mcp-exposure-")));
  app = await buildServer(options());
  fixture = await mcpFixture({ toolCount: 7 });
  await mkdir(join(root, "work"));
  workspace = await app.projects.prepare(join(root, "work"));
});
afterEach(async () => {
  await app?.server.close();
  await fixture?.close();
  await provider?.close();
  provider = undefined;
  await rm(root, { recursive: true, force: true });
});
async function save(
  document: McpConfigDocument,
  target: McpConfigTarget = { scope: "user" },
) {
  const view = await app.mcpManager.config(target);
  await app.mcpManager.save({
    ...target,
    expectedRevision: view.revision,
    document,
  });
  await app.mcpManager.activate(workspace);
}
async function run(project = workspace) {
  // 产品路由会先激活项目连接；此处直接调用用例，显式完成同一步准备。
  await app.mcpManager.activate(project);
  const session = await app.projects.create({ path: project.path });
  const active = app.store.beginRun({
    sessionId: session.id,
    expectedRevision: session.revision,
    requestId: randomUUID(),
    fingerprint: "exposure-fixture",
    kind: "send",
    content: "工具提供测试",
    model: "fixture",
    contextTrimmed: false,
  });
  app.store.execution.put("checkpoints", {
    id: active.id,
    runId: active.id,
    sessionId: session.id,
    settings: app.store.settings(),
    limits: AGENT_LIMITS,
    instructions: "",
    current: [],
    history: [],
    runtime: null,
    loadedTools: [],
    activeMilliseconds: 0,
    updatedAt: new Date().toISOString(),
  });
  return { active, executor: app.toolSystem.forRun(active.id, session.id) };
}
const mcpNames = async (executor: ReturnType<typeof app.toolSystem.forRun>) =>
  ((await executor.snapshot?.()) ?? [])
    .filter((tool) => tool.name.startsWith("mcp_"))
    .map((tool) => tool.name);

it("直接服务首个快照提供全部七个工具，旧配置默认按需，后续搜索累积且不挤占直接工具", async () => {
  await save({
    mcpServers: {
      direct: { url: fixture.url, toolExposure: "direct" },
      deferred: { url: fixture.url },
    },
  });
  const { active, executor } = await run();
  const initial = await mcpNames(executor);
  expect(initial).toHaveLength(7);
  expect(
    app.store.execution.get("checkpoints", active.id)?.loadedTools,
  ).toEqual([]);
  const first = app.toolSystem.searchTools(active.id, "");
  expect(first).toMatchObject({ tools: expect.any(Array), cursor: "5" });
  expect(await mcpNames(executor)).toHaveLength(12);
  app.toolSystem.searchTools(active.id, "", "5");
  expect(await mcpNames(executor)).toHaveLength(14);
  expect(await mcpNames(executor)).toEqual(expect.arrayContaining(initial));
  expect(
    app.store.execution.get("checkpoints", active.id)?.loadedTools,
  ).toHaveLength(7);
  expect(fixture.calls).toHaveLength(0);
});

it("项目级省略方式覆盖用户级 direct，外部改为 direct 必须确认且不影响其他项目", async () => {
  await save({
    mcpServers: { echo: { url: fixture.url, toolExposure: "direct" } },
  });
  await save(
    { mcpServers: { echo: { url: fixture.url } } },
    { scope: "project", workspaceId: workspace.id },
  );
  const first = await run();
  expect(await mcpNames(first.executor)).toHaveLength(0);
  await mkdir(join(root, "other"));
  const other = await app.projects.prepare(join(root, "other"));
  const second = await run(other);
  expect(await mcpNames(second.executor)).toHaveLength(7);
  const path = join(workspace.path, ".myagent", "mcp.json");
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: { echo: { url: fixture.url, toolExposure: "direct" } },
    }),
  );
  const pending = await app.mcpManager.config({
    scope: "project",
    workspaceId: workspace.id,
  });
  expect(pending.pending).toBe(true);
  expect(await mcpNames(first.executor)).toHaveLength(0);
  expect(await mcpNames(second.executor)).toHaveLength(7);
  await app.mcpManager.confirm({
    ...pending.target,
    expectedRevision: pending.revision,
  });
  await app.mcpManager.activate(workspace);
  expect(await mcpNames(first.executor)).toHaveLength(7);
});

it("运行中切换方式更新下次快照，旧版本调用拒绝派发，禁用服务仍不可见", async () => {
  await save({
    mcpServers: { echo: { url: fixture.url, toolExposure: "direct" } },
  });
  const { active, executor } = await run();
  const [name] = await mcpNames(executor);
  if (!name) throw new Error("直接工具应当可见");
  await save({
    mcpServers: { echo: { url: fixture.url, toolExposure: "deferred" } },
  });
  const results = await executor.executeBatch?.({
    runId: active.id,
    stepId: "old-step",
    calls: [{ id: "old", name, arguments: '{"text":"hello"}' }],
    limits: AGENT_LIMITS,
    signal: new AbortController().signal,
    onUpdate: async () => {},
  });
  expect(results?.[0]?.error?.code).toBe("tool_changed");
  expect(fixture.calls).toHaveLength(0);
  expect(await mcpNames(executor)).toHaveLength(0);
  app.toolSystem.searchTools(active.id, "echo");
  expect(await mcpNames(executor)).toHaveLength(5);
  await save({
    mcpServers: {
      echo: { url: fixture.url, toolExposure: "direct", enabled: false },
    },
  });
  expect(await mcpNames(executor)).toHaveLength(0);
  expect(app.toolSystem.searchTools(active.id, "echo")).toMatchObject({
    tools: [],
  });
});

it("直接提供只影响定义可见性，真实业务调用仍须审批并保持调用配对", async () => {
  await save({
    mcpServers: { echo: { url: fixture.url, toolExposure: "direct" } },
  });
  const { active, executor } = await run();
  const [name] = await mcpNames(executor);
  if (!name) throw new Error("直接工具应当可见");
  const batch = {
    runId: active.id,
    stepId: "step",
    calls: [{ id: "direct-call", name, arguments: '{"text":"hello"}' }],
    limits: AGENT_LIMITS,
    signal: new AbortController().signal,
    onUpdate: async () => {},
  };
  await expect(executor.executeBatch?.(batch)).rejects.toMatchObject({
    code: "execution_paused",
  });
  expect(fixture.calls).toHaveLength(0);
  const approval = app.store.execution.list("approvals", {
    runId: active.id,
  })[0];
  if (!approval) throw new Error("必须先创建审批");
  app.toolSystem.decide(approval.id, {
    requestId: randomUUID(),
    decision: "allow",
    scope: "once",
  });
  app.store.execution.setRunStatus(active.id, "running");
  const results = await executor.executeBatch?.(batch);
  expect(results?.[0]).toMatchObject({ callId: "direct-call", ok: true });
  expect(fixture.calls).toHaveLength(1);
  expect(
    app.store.execution.get("checkpoints", active.id)?.loadedTools,
  ).toEqual([]);
});

it("文件与旧 API 往返保留方式，非法值不写入，重启保持 direct 和旧记录默认值", async () => {
  await save({
    mcpServers: { echo: { url: fixture.url, toolExposure: "direct" } },
  });
  const connection = app.mcpSettings.list()[0];
  if (!connection) throw new Error("缺少连接");
  expect(connection.toolExposure).toBe("direct");
  const response = await app.server.inject({
    method: "PUT",
    url: `/api/v1/mcp/connections/${connection.id}`,
    payload: {
      name: "echo",
      transport: "http",
      url: fixture.url,
      auth: "none",
      workspaceIds: [workspace.id],
      expectedRevision: connection.revision,
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().toolExposure).toBe("direct");
  const view = await app.mcpManager.config({ scope: "user" });
  for (const toolExposure of ["eager", null, 42]) {
    const invalid = await app.server.inject({
      method: "PUT",
      url: "/api/v1/mcp/config",
      payload: {
        scope: "user",
        expectedRevision: view.revision,
        document: { mcpServers: { echo: { url: fixture.url, toolExposure } } },
      },
    });
    expect(invalid.statusCode).toBe(400);
  }
  expect((await app.mcpManager.config({ scope: "user" })).revision).toBe(
    view.revision,
  );
  expect(
    JSON.parse(await readFile(join(root, "data", "mcp.json"), "utf8"))
      .mcpServers.echo.toolExposure,
  ).toBe("direct");
  await app.server.close();
  app = await buildServer(options());
  await app.mcpManager.activate(workspace);
  expect(await mcpNames((await run()).executor)).toHaveLength(7);
  await save({ mcpServers: { echo: { url: fixture.url } } });
  const old = app.store.execution.list("connections")[0];
  if (!old) throw new Error("缺少旧记录");
  delete old.toolExposure;
  app.store.execution.put("connections", old);
  expect(app.mcpSettings.list()[0]?.toolExposure).toBe("deferred");
  expect(await mcpNames((await run()).executor)).toHaveLength(0);
});

it.each<ApiProtocol>(["responses", "chat_completions"])(
  "%s 首次真实 HTTP 模型请求即带 direct 定义，审批后执行 MCP 并在后续模型请求复用",
  async (apiProtocol) => {
    // 本地模型协议替身按收到的真实工具定义返回调用，避免直接越过 Loop 验证快照。
    provider = await mockProvider(0, (_question, results, definitions) => {
      const tools = definitions as {
        name?: string;
        function?: { name: string };
      }[];
      const name = tools
        .map((tool) => tool.name ?? tool.function?.name)
        .find((name) => name?.startsWith("mcp_"));
      return {
        calls:
          !results.length && name
            ? [
                {
                  id: "direct-model-call",
                  name,
                  arguments: '{"text":"真实协议回声"}',
                },
              ]
            : [],
        text: results.length ? "已收到回声结果。" : "准备调用。",
      };
    });
    app.settings.save({
      baseUrl: provider.url,
      model: "fixture",
      apiProtocol,
      apiKey: "fixture-only",
      systemPrompt: "",
      expectedRevision: app.settings.get().revision,
    });
    await save({
      mcpServers: { echo: { url: fixture.url, toolExposure: "direct" } },
    });
    const session = await app.projects.create({ path: workspace.path });
    const accepted = app.chat.start(session.id, {
      requestId: randomUUID(),
      expectedRevision: session.revision,
      content: "请查询回声。",
    });
    await expect
      .poll(() => app.store.getRun(accepted.run.id).status)
      .toBe("waiting_approval");
    expect(provider.requests).toHaveLength(1);
    expect(fixture.calls).toHaveLength(0);
    const approval = app.store.execution.list("approvals", {
      runId: accepted.run.id,
    })[0];
    if (!approval) throw new Error("业务调用仍须审批");
    app.toolSystem.decide(approval.id, {
      requestId: randomUUID(),
      decision: "allow",
      scope: "once",
    });
    await app.chat.resume(accepted.run.id);
    await expect
      .poll(() => app.store.getRun(accepted.run.id).status)
      .toBe("succeeded");
    expect(provider.requests).toHaveLength(2);
    for (const request of provider.requests) {
      const definitions = request.tools as {
        name?: string;
        function?: { name: string };
      }[];
      expect(
        definitions.filter((tool) =>
          (tool.name ?? tool.function?.name)?.startsWith("mcp_"),
        ),
      ).toHaveLength(7);
    }
    expect(fixture.calls).toHaveLength(1);
    expect(
      app.store
        .getSteps(accepted.run.id)
        .flatMap((record) => record.step.tools)
        .map((tool) => tool.name),
    ).not.toContain("search_tools");
  },
);
