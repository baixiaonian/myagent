/**
 * MCP 会话选择集成验收：临时 SQLite、真实本地 HTTP 协议服务与应用 Loop 验证跨轮复用。
 * 覆盖版本、隔离、预算及迟到写入；本地模型仅验证传输与控制流，不作为真实模型能力证据。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import {
  AGENT_LIMITS,
  type ApiProtocol,
  type McpServerConfig,
  type Session,
  type Workspace,
} from "../../packages/contracts/src/index.js";
import type { ExecutionRecords } from "../../packages/state/src/index.js";
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
  root = await realpath(
    await mkdtemp(join(tmpdir(), "myagent-mcp-selection-")),
  );
  app = await buildServer(options());
  fixture = await mcpFixture({ toolCount: 7 });
  await mkdir(join(root, "work"));
  workspace = await app.projects.prepare(join(root, "work"));
  await configure();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.server.close();
  await fixture?.close();
  await provider?.close();
  provider = undefined;
  // 只清理本测试独占目录，不触碰用户配置、凭证或项目文件。
  await rm(root, { recursive: true, force: true });
});
async function configure(change: Partial<McpServerConfig> = {}) {
  const view = await app.mcpManager.config({ scope: "user" });
  await app.mcpManager.save({
    scope: "user",
    expectedRevision: view.revision,
    document: { mcpServers: { echo: { url: fixture.url, ...change } } },
  });
  await app.mcpManager.activate(workspace);
}
async function begin(session?: Session) {
  const current =
    session ?? (await app.projects.create({ path: workspace.path }));
  const active = app.store.beginRun({
    sessionId: current.id,
    expectedRevision: app.store.snapshot(current.id).session.revision,
    requestId: randomUUID(),
    fingerprint: "selection-fixture",
    kind: "send",
    content: "工具选择",
    model: "fixture",
    contextTrimmed: false,
  });
  app.store.execution.put("checkpoints", {
    id: active.id,
    runId: active.id,
    sessionId: current.id,
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
  app.toolSystem.initializeRunTools(active.id, current.id);
  return {
    active,
    session: current,
    executor: app.toolSystem.forRun(active.id, current.id),
  };
}
function finish(runId: string) {
  app.store.finishRun(runId, {
    status: "succeeded",
    finishReason: "stop",
    usage: null,
    error: null,
  });
}
const names = async (run: Awaited<ReturnType<typeof begin>>) =>
  ((await run.executor.snapshot?.()) ?? [])
    .filter((tool) => tool.name.startsWith("mcp_"))
    .map((tool) => tool.name);

it("同会话新 Run 继承选择，同项目新会话和其他项目均不继承", async () => {
  const first = await begin();
  expect(await names(first)).toEqual([]);
  app.toolSystem.searchTools(first.active.id, "echo", "0", 1);
  const selected = await names(first);
  expect(selected).toHaveLength(1);
  finish(first.active.id);
  const next = await begin(first.session);
  expect(await names(next)).toEqual(selected);
  expect(await names(await begin())).toEqual([]);
  await mkdir(join(root, "other"));
  const other = await app.projects.prepare(join(root, "other"));
  await app.mcpManager.activate(other);
  expect(
    await names(await begin(await app.projects.create({ path: other.path }))),
  ).toEqual([]);
  expect(fixture.calls).toHaveLength(0);
});

it("同版本断连期间不暴露定义，重连复用；定义变化须重新搜索", async () => {
  const first = await begin();
  app.toolSystem.searchTools(first.active.id, "echo", "0", 1);
  const selected = await names(first);
  finish(first.active.id);
  const connection = app.mcpSettings.list()[0];
  if (!connection) throw new Error("缺少连接");
  await app.mcp.disconnect(connection.id, workspace.id);
  const next = await begin(first.session);
  expect(await names(next)).toEqual([]);
  await app.mcp.connect(connection.id, workspace.id);
  expect(await names(next)).toEqual(selected);
  fixture.setDescription("调整后的回声定义");
  await app.mcp.disconnect(connection.id, workspace.id);
  await app.mcp.connect(connection.id, workspace.id);
  expect(await names(next)).toEqual([]);
  app.toolSystem.searchTools(next.active.id, "echo", "0", 1);
  expect(await names(next)).toEqual(selected);
  finish(next.active.id);
  expect(await names(await begin(first.session))).toEqual(selected);
  expect(fixture.calls).toHaveLength(0);
});

it.each(["disable", "revision", "blocked", "workspace", "identity"])(
  "%s 变化后不继承旧定义",
  async (change) => {
    const first = await begin();
    app.toolSystem.searchTools(first.active.id, "echo", "0", 1);
    finish(first.active.id);
    if (change === "disable") await configure({ enabled: false });
    else if (change === "revision")
      await configure({ auth: "none", toolExposure: "deferred" });
    else if (change === "identity") {
      // 模拟目录被替换后的新身份；不修改真实用户文件。
      app.store.execution.put("workspaces", {
        ...workspace,
        identity: "replaced-fixture-directory",
      });
    } else {
      const connection = app.store.execution.list("connections")[0];
      if (!connection) throw new Error("缺少连接");
      // 投影级故障注入，单独检查信任/作用域闸门，即使注册表仍留有旧条目也不能暴露。
      app.store.execution.put("connections", {
        ...connection,
        ...(change === "blocked" ? { blocked: true } : { workspaceIds: [] }),
      });
    }
    expect(await names(await begin(first.session))).toEqual([]);
    expect(
      app.store.execution.get("sessionTools", first.session.id)?.tools,
    ).toEqual([]);
  },
);

it("跨轮预算淘汰持续生效，直接服务不占用按需缓存", async () => {
  fixture.setDescription("较大定义".repeat(900));
  const connection = app.mcpSettings.list()[0];
  if (!connection) throw new Error("缺少连接");
  await app.mcp.disconnect(connection.id, workspace.id);
  await app.mcp.connect(connection.id, workspace.id);
  const first = await begin();
  const result = app.toolSystem.searchTools(first.active.id, "echo", "0", 5);
  expect(result).toMatchObject({ evicted: expect.any(Array) });
  const remaining = await names(first);
  expect(remaining.length).toBeGreaterThan(0);
  expect(remaining.length).toBeLessThan(5);
  finish(first.active.id);
  const next = await begin(first.session);
  expect(await names(next)).toEqual(remaining);
  await configure({ toolExposure: "direct" });
  expect(await names(next)).toHaveLength(7);
  app.toolSystem.searchTools(next.active.id, "echo");
  expect(
    app.store.execution.get("sessionTools", first.session.id)?.tools,
  ).toEqual([]);
});

it("旧检查点仅有名称时不继承未知版本；新搜索后能够安全继续", async () => {
  const first = await begin();
  app.toolSystem.searchTools(first.active.id, "echo", "0", 1);
  const checkpoint = app.store.execution.get("checkpoints", first.active.id);
  if (!checkpoint) throw new Error("缺少检查点");
  delete checkpoint.loadedToolBindings;
  app.store.execution.put("checkpoints", checkpoint);
  app.store.execution.remove("sessionTools", first.session.id);
  expect(await names(first)).toEqual([]);
  app.toolSystem.searchTools(first.active.id, "echo", "0", 1);
  expect(await names(first)).toHaveLength(1);
});

it("缓存和检查点原子保存；终态迟到搜索不得更新缓存，删除会话级联清理", async () => {
  const first = await begin();
  app.toolSystem.searchTools(first.active.id, "echo", "0", 1);
  const before = app.store.execution.get("sessionTools", first.session.id);
  const checkpoint = app.store.execution.get("checkpoints", first.active.id);
  const put = app.store.execution.put.bind(app.store.execution);
  const failing = vi
    .spyOn(app.store.execution, "put")
    .mockImplementation(
      <K extends keyof ExecutionRecords>(
        kind: K,
        value: ExecutionRecords[K],
      ) => {
        if (kind === "sessionTools") throw new Error("fixture storage failure");
        return put(kind, value);
      },
    );
  expect(() =>
    app.toolSystem.searchTools(first.active.id, "echo", "1", 1),
  ).toThrow("fixture storage failure");
  failing.mockRestore();
  expect(app.store.execution.get("checkpoints", first.active.id)).toEqual(
    checkpoint,
  );
  expect(app.store.execution.get("sessionTools", first.session.id)).toEqual(
    before,
  );
  finish(first.active.id);
  expect(() =>
    app.toolSystem.searchTools(first.active.id, "echo", "1", 1),
  ).toThrow();
  expect(app.store.execution.get("sessionTools", first.session.id)).toEqual(
    before,
  );
  await app.chat.deleteSession(first.session.id);
  expect(app.store.execution.get("sessionTools", first.session.id)).toBeNull();
  expect(() => app.toolSystem.searchTools(first.active.id, "echo")).toThrow();
  expect(app.store.execution.list("sessionTools")).toEqual([]);
});

it.each<ApiProtocol>(["responses", "chat_completions"])(
  "%s 首轮搜索，重启后追问首个请求直接带已加载工具，仍需要新的执行审批",
  async (apiProtocol) => {
    provider = await mockProvider(0, (_question, results, definitions) => {
      const tools = definitions as {
        name?: string;
        function?: { name: string };
      }[];
      const tool = tools
        .map((item) => item.name ?? item.function?.name)
        .find((name) => name?.startsWith("mcp_"));
      return {
        calls: results.some((result) => result.content.includes("缓存回声"))
          ? []
          : tool
            ? [
                {
                  id: "echo-call",
                  name: tool,
                  arguments: '{"text":"缓存回声"}',
                },
              ]
            : [
                {
                  id: "search-call",
                  name: "search_tools",
                  arguments: '{"query":"echo","limit":1}',
                },
              ],
        text: "回声测试",
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
    const session = await app.projects.create({ path: workspace.path });
    for (const round of [1, 2]) {
      if (round === 2) {
        // 真正关闭并重建应用；必须重新握手，不沿用内存缓存或已连接标识。
        await app.server.close();
        app = await buildServer(options());
        await app.mcpManager.activate(workspace);
        expect(fixture.calls).toHaveLength(1);
      }
      const startIndex = provider.requests.length;
      const accepted = app.chat.start(session.id, {
        requestId: randomUUID(),
        expectedRevision: app.store.snapshot(session.id).session.revision,
        content: `请执行第 ${round} 次回声`,
      });
      await expect
        .poll(() => app.store.getRun(accepted.run.id).status)
        .toBe("waiting_approval");
      expect(fixture.calls).toHaveLength(round - 1);
      const approval = app.store.execution.list("approvals", {
        runId: accepted.run.id,
      })[0];
      if (!approval) throw new Error("复用定义不能复用一次性审批");
      app.toolSystem.decide(approval.id, {
        requestId: randomUUID(),
        decision: "allow",
        scope: "once",
      });
      await app.chat.resume(accepted.run.id);
      await expect
        .poll(() => app.store.getRun(accepted.run.id).status)
        .toBe("succeeded");
      expect(fixture.calls).toHaveLength(round);
      const requests = provider.requests.slice(startIndex);
      expect(requests).toHaveLength(round === 1 ? 3 : 2);
      const definitions = requests[0]?.tools as {
        name?: string;
        function?: { name: string };
      }[];
      expect(
        definitions.filter((tool) =>
          (tool.name ?? tool.function?.name)?.startsWith("mcp_"),
        ),
      ).toHaveLength(round - 1);
      const called = app.store
        .getSteps(accepted.run.id)
        .flatMap((record) => record.step.tools)
        .map((tool) => tool.name);
      if (round === 1) expect(called).toContain("search_tools");
      else expect(called).not.toContain("search_tools");
      // 私有缓存不进入公开快照/SSE；模型只接收注册表中的标准工具定义。
      expect(JSON.stringify(app.store.snapshot(session.id))).not.toContain(
        "loadedToolBindings",
      );
      expect(JSON.stringify(app.store.events(session.id, 0))).not.toContain(
        "connectionRevision",
      );
    }
  },
);
