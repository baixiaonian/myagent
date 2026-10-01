/**
 * MCP 专项：真实 HTTP + 官方 SDK 验证发现、认证、错误和凭证边界；stdio 另用真实 OS 沙箱。
 * OAuth 服务是本地协议替身，只证明协议实现，不代表所有第三方服务商已验收。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import type {
  McpConnection,
  Workspace,
} from "../../packages/contracts/src/index.js";
import { mcpFixture } from "./mcp-fixture.js";

let root: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let fixture: Awaited<ReturnType<typeof mcpFixture>> | undefined;
let workspace: Workspace;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "myagent-mcp-test-")));
  const work = join(root, "work");
  await mkdir(work);
  app = await buildServer({ dataDir: join(root, "data"), serveWeb: false });
  workspace = await app.toolSystem.createWorkspace(work, "MCP 测试");
});
afterEach(async () => {
  await app?.server.close();
  await fixture?.close();
  fixture = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});
async function call(
  connection: McpConnection,
  text: string,
  signal = new AbortController().signal,
  executionMode: "standard" | "full_access" = "standard",
) {
  const descriptor = app.registry
    .descriptors()
    .find(
      (item) =>
        item.source.kind === "mcp" &&
        item.source.connectionId === connection.id &&
        (item.source.executionMode ?? "standard") === executionMode,
    );
  if (!descriptor) throw new Error("missing descriptor");
  const context = {
    executionMode,
    runId: "mcp-test",
    sessionId: "s",
    stepId: "step",
    invocationId: randomUUID(),
    workspace,
  };
  const prepared = await app.registry.prepare(
    descriptor.name,
    JSON.stringify({ text }),
    context,
  );
  return app.mcp.call(
    {
      attemptId: randomUUID(),
      context,
      prepared,
      authorizedResources: prepared.resources,
      timeoutMs: 1000,
    },
    signal,
  );
}
describe("HTTP MCP 与 OAuth", () => {
  it("统一发现工具、忽略自称只读的标记，并保存安全的 Token 引用", async () => {
    fixture = await mcpFixture({ token: "mcp-private-test-token" });
    const connection = await app.mcpSettings.save({
      name: "fixture",
      transport: "http",
      url: fixture.url,
      auth: "token",
      token: "mcp-private-test-token",
      workspaceIds: [workspace.id],
    });
    expect(JSON.stringify(app.mcpSettings.list())).not.toContain(
      "mcp-private-test-token",
    );
    expect((await app.mcp.connect(connection.id, workspace.id)).tools).toBe(1);
    const descriptor = app.registry
      .descriptors()
      .find((tool) => tool.source.kind === "mcp");
    expect(descriptor?.effects).toBe("unknown");
    expect(descriptor?.name.length).toBeLessThanOrEqual(64);
    expect(JSON.stringify(await call(connection, "hello"))).toContain("hello");
    const result = JSON.stringify(await call(connection, "secret"));
    expect(result).not.toContain("mcp-private-test-token");
    expect(result).toContain("已隐藏凭证");
  });
  it("工具错误保持 isError，401 不自动重发工具请求", async () => {
    fixture = await mcpFixture();
    const connection = await app.mcpSettings.save({
      name: "errors",
      transport: "http",
      url: fixture.url,
      auth: "none",
      workspaceIds: [workspace.id],
    });
    await app.mcp.connect(connection.id, workspace.id);
    expect(await call(connection, "fail")).toMatchObject({ isError: true });
    fixture.rejectToolCalls();
    const before = fixture.calls.length;
    await expect(call(connection, "write")).rejects.toBeDefined();
    expect(fixture.calls.length - before).toBe(1);
  });
  it("OAuth 使用 PKCE 和一次性 state，回调不公开 Token，刷新后可以重新连接", async () => {
    fixture = await mcpFixture({ oauth: true });
    const connection = await app.mcpSettings.save({
      name: "oauth",
      transport: "http",
      url: fixture.url,
      auth: "oauth",
      workspaceIds: [workspace.id],
    });
    const pending = await app.mcp.connect(connection.id, workspace.id);
    expect(pending.ok).toBe(false);
    expect(pending.authorizationUrl).toBeTruthy();
    const authorization = new URL(pending.authorizationUrl ?? "");
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const state = authorization.searchParams.get("state") ?? "";
    await expect(
      app.mcp.finishAuth("invalid-state", "code"),
    ).rejects.toMatchObject({ code: "oauth_state" });
    await app.mcp.finishAuth(state, "fixture-code");
    expect(fixture.exchanges[0]?.get("code_verifier")).toBeTruthy();
    await expect(
      app.mcp.finishAuth(state, "fixture-code"),
    ).rejects.toMatchObject({ code: "oauth_state" });
    expect(JSON.stringify(app.mcpSettings.list())).not.toContain(
      "mcp-fixture-access",
    );
    expect(JSON.stringify(await call(connection, "secret"))).toContain(
      "已隐藏凭证",
    );
    fixture.setToken("mcp-new-access");
    await app.mcp.disconnect(connection.id);
    await app.mcp.connect(connection.id, workspace.id);
    expect(
      fixture.exchanges.some(
        (params) => params.get("grant_type") === "refresh_token",
      ),
    ).toBe(true);
    const removed = await app.mcpSettings.remove(connection.id);
    expect(removed.remoteRevocation).toBe("succeeded");
    expect(fixture.revocations).toBe(2);
  });
  it("拒绝危险环境覆盖，配置更新具有版本保护", async () => {
    await expect(
      app.mcpSettings.save({
        name: "bad",
        transport: "stdio",
        command: "node",
        auth: "none",
        workspaceIds: [workspace.id],
        environment: { NODE_OPTIONS: "--require evil.js" },
      }),
    ).rejects.toMatchObject({ code: "invalid_environment" });
    fixture = await mcpFixture();
    const connection = await app.mcpSettings.save({
      name: "revision",
      transport: "http",
      url: fixture.url,
      auth: "none",
      workspaceIds: [workspace.id],
    });
    await expect(
      app.mcpSettings.save(
        {
          name: "revision",
          transport: "http",
          url: fixture.url,
          auth: "none",
          workspaceIds: [workspace.id],
          expectedRevision: 99,
        },
        connection.id,
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });
});
it.runIf(process.env.MYAGENT_TEST_NATIVE === "1")(
  "真实 stdio 服务在原生沙箱中启动，环境凭证不进入工具结果",
  async () => {
    const connection = await app.mcpSettings.save({
      name: "stdio",
      transport: "stdio",
      command: process.execPath,
      args: [join(process.cwd(), "tests/execution/mcp-server.mjs")],
      auth: "none",
      environment: { MCP_FIXTURE_TOKEN: "stdio-private-test-token" },
      workspaceIds: [workspace.id],
    });
    expect((await app.mcp.connect(connection.id, workspace.id)).tools).toBe(1);
    expect(JSON.stringify(await call(connection, "hello"))).toContain("hello");
    const result = JSON.stringify(await call(connection, "secret"));
    expect(result).not.toContain("stdio-private-test-token");
    expect(result).toContain("已隐藏凭证");
  },
  20000,
);

// 两种连接必须能同时存在；其中一种断开不能移除另一种的目录或复用其进程。
it("HTTP MCP 完全访问目录与标准目录隔离，断开一方不影响另一方", async () => {
  fixture = await mcpFixture();
  const connection = await app.mcpSettings.save({
    name: "two-modes",
    transport: "http",
    url: fixture.url,
    auth: "none",
    workspaceIds: [workspace.id],
  });
  await app.mcp.connect(connection.id, workspace.id);
  await app.mcp.connect(connection.id, workspace.id, "full_access");
  const tools = app.registry
    .descriptors()
    .filter((d) => d.source.kind === "mcp");
  expect(tools).toHaveLength(2);
  expect(new Set(tools.map((d) => d.name)).size).toBe(2);
  expect(
    JSON.stringify(await call(connection, "full", undefined, "full_access")),
  ).toContain("full");
  await app.mcp.disconnect(connection.id, workspace.id, "full_access");
  expect(app.mcp.state(connection.id, workspace.id).status).toBe("connected");
  expect(app.mcp.state(connection.id, workspace.id, "full_access").status).toBe(
    "disconnected",
  );
  expect(JSON.stringify(await call(connection, "standard"))).toContain(
    "standard",
  );
});
it("完全访问 stdio 使用真实进程，保护连接凭证且不发布到标准目录", async () => {
  const connection = await app.mcpSettings.save({
    name: "full-stdio",
    transport: "stdio",
    command: process.execPath,
    args: [join(process.cwd(), "tests/execution/mcp-server.mjs")],
    auth: "none",
    environment: { MCP_FIXTURE_TOKEN: "full-private-token" },
    workspaceIds: [workspace.id],
  });
  expect(
    (await app.mcp.connect(connection.id, workspace.id, "full_access")).tools,
  ).toBe(1);
  expect(app.mcp.state(connection.id, workspace.id).status).toBe(
    "disconnected",
  );
  expect(
    JSON.stringify(
      await call(connection, "hello-full", undefined, "full_access"),
    ),
  ).toContain("hello-full");
  expect(
    JSON.stringify(await call(connection, "secret", undefined, "full_access")),
  ).not.toContain("full-private-token");
}, 20000);
