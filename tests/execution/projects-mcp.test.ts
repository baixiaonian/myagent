/**
 * 项目与 MCP 文件管理集成验收：真实磁盘、SQLite 与本地 HTTP MCP，验证身份/权限/凭证边界。
 * 所有目录与服务器属于本测试；不读取用户配置，不把协议替身当作外部生产服务验收。
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import { LocalWorkspace } from "../../packages/adapters/src/index.js";
import type {
  McpConfigDocument,
  McpConfigTarget,
  Workspace,
} from "../../packages/contracts/src/index.js";
import { mcpFixture } from "./mcp-fixture.js";

let root: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let fixtures: Awaited<ReturnType<typeof mcpFixture>>[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "myagent-projects-")));
  app = await buildServer({
    dataDir: join(root, "data"),
    workspaceRoot: join(root, "defaults"),
    serveWeb: false,
    directoryPicker: async () => ({ status: "cancelled" }),
  });
});
afterEach(async () => {
  await app?.server.close();
  for (const fixture of fixtures) await fixture.close();
  fixtures = [];
  await rm(root, { recursive: true, force: true });
});
async function project(name: string): Promise<Workspace> {
  const path = join(root, name);
  await mkdir(path);
  return app.projects.prepare(path);
}
async function fixture() {
  const value = await mcpFixture();
  fixtures.push(value);
  return value;
}
async function save(target: McpConfigTarget, document: McpConfigDocument) {
  const view = await app.mcpManager.config(target);
  return app.mcpManager.save({
    ...target,
    expectedRevision: view.revision,
    document,
    convertSecrets: true,
  });
}
it("新会话自动分配不同目录，创建重试不重复，删除不删除文件或复活会话", async () => {
  const requestId = randomUUID();
  const [a, again] = await Promise.all([
    app.projects.create({ requestId }),
    app.projects.create({ requestId }),
  ]);
  const b = await app.projects.create();
  expect(a.id).toBe(again.id);
  expect(a.workspaceId).not.toBe(b.workspaceId);
  const workspace = app.store.execution.get(
    "workspaces",
    a.workspaceId as string,
  );
  expect(workspace?.kind).toBe("default");
  expect((await stat(workspace?.path as string)).isDirectory()).toBe(true);
  await writeFile(join(workspace?.path as string, "result.txt"), "用户产物");
  await app.chat.deleteSession(a.id);
  expect(
    await readFile(join(workspace?.path as string, "result.txt"), "utf8"),
  ).toBe("用户产物");
  expect(() => app.projects.create({ requestId })).toThrow(/不存在/);
});
it("选目录只登记项目，取消原生窗口不创建会话，受保护目录与符号链接被拒绝", async () => {
  const workspace = await project("work");
  expect(app.store.listSessions()).toHaveLength(0);
  const response = await app.server.inject({
    method: "POST",
    url: "/api/v1/projects/pick",
    headers: { origin: "http://localhost:80" },
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().status).toBe("cancelled");
  expect(app.store.listSessions()).toHaveLength(0);
  const session = await app.projects.create({ path: workspace.path });
  expect(session.workspaceId).toBe(workspace.id);
  await expect(app.projects.prepare(join(root, "data"))).rejects.toMatchObject({
    code: "protected_path",
  });
  await symlink(join(root, "data"), join(root, "data-link"));
  await expect(
    app.projects.prepare(join(root, "data-link")),
  ).rejects.toMatchObject({ code: "protected_path" });
});
it("旧未绑定会话补充分配目录，并保持历史记录与绑定稳定", async () => {
  const old = app.store.createSession();
  const workspace = await app.projects.ensure(old.id);
  expect((await app.projects.ensure(old.id)).id).toBe(workspace.id);
  expect(app.store.snapshot(old.id).session.workspaceId).toBe(workspace.id);
});
it("目录身份变化后可为新对话重新选择，旧会话和旧授权不能迁移", async () => {
  const original = await project("reselected");
  const session = await app.projects.create({ path: original.path });
  // 模拟重新挂载导致原 dev/ino 指纹失效；保留原事实以核验没有静默改绑。
  const stale = { ...original, identity: "previous-mount-identity" };
  app.store.execution.put("workspaces", stale);
  app.store.execution.put("grants", {
    id: "old-grant",
    workspaceId: stale.id,
    sessionId: null,
    scope: "workspace",
    decision: "allow",
    resources: [{ kind: "path", target: root, access: "read" }],
    fingerprint: null,
    invocationId: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });
  const next = await app.projects.prepare(original.path);
  expect(next.id).not.toBe(original.id);
  expect(next.identity).toBe(original.identity);
  expect(app.store.snapshot(session.id).session.workspaceId).toBe(original.id);
  expect(app.store.execution.get("workspaces", original.id)).toEqual(stale);
  expect(app.store.execution.get("grants", "old-grant")?.workspaceId).toBe(
    original.id,
  );
  expect((await app.projects.prepare(original.path)).id).toBe(next.id);
  expect(
    app.projects
      .list()
      .filter((p) => p.path === original.path)
      .map((p) => p.id),
  ).toEqual([next.id]);
  await expect(new LocalWorkspace([]).validate(stale)).rejects.toMatchObject({
    code: "workspace_changed",
  });
  expect((await app.projects.create({ path: next.path })).workspaceId).toBe(
    next.id,
  );
});
it("MCP 表单与文件共用事实源，认证转换后公开接口、配置和数据库不含明文", async () => {
  const service = await mcpFixture({ token: "private-project-token" });
  fixtures.push(service);
  const overview = await app.mcpManager.overview();
  expect(app.store.listSessions()).toHaveLength(0);
  const saved = await save(
    { scope: "user" },
    {
      mcpServers: {
        echo: { url: service.url, token: "private-project-token" },
      },
    },
  );
  expect(saved.containsSecrets).toBe(false);
  expect(JSON.stringify(saved)).not.toContain("private-project-token");
  const text = await readFile(join(root, "data", "mcp.json"), "utf8");
  expect(text).toContain(`\${secret:token}`);
  expect(text).not.toContain("private-project-token");
  await app.mcpManager.activate(overview.workspace);
  const next = await app.mcpManager.overview();
  await expect
    .poll(
      () =>
        app.mcp.state(next.servers[0]?.id as string, next.workspace.id).status,
    )
    .toBe("connected");
  const final = await app.mcpManager.overview();
  expect(final.servers[0]?.tools[0]?.name).toBe("echo");
  expect(JSON.stringify(app.store.execution.list("mcpFiles"))).not.toContain(
    "private-project-token",
  );
  expect(JSON.stringify(app.store.execution.list("connections"))).not.toContain(
    "private-project-token",
  );
  expect(app.store.listSessions()).toHaveLength(0);
});
it("外部项目配置必须确认准确版本，同名禁用覆盖用户级，外部修改不会自动执行", async () => {
  const service = await fixture();
  const workspace = await project("project");
  await save({ scope: "user" }, { mcpServers: { echo: { url: service.url } } });
  await app.mcpManager.activate(workspace);
  const target = { scope: "project" as const, workspaceId: workspace.id };
  const path = join(workspace.path, ".myagent", "mcp.json");
  await mkdir(join(workspace.path, ".myagent"));
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: { echo: { url: service.url, enabled: false } },
    }),
  );
  const before = service.initializeCount;
  const view = await app.mcpManager.config(target);
  expect(view.pending).toBe(true);
  const state = await app.mcpManager.overview(workspace.id);
  expect(state.servers.find((s) => s.scope === "user")?.overridden).toBe(true);
  expect(service.initializeCount).toBe(before);
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: { echo: { url: service.url, enabled: true } },
    }),
  );
  await expect(
    app.mcpManager.confirm({ ...target, expectedRevision: view.revision }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  const latest = await app.mcpManager.config(target);
  await app.mcpManager.confirm({
    ...target,
    expectedRevision: latest.revision,
  });
  await app.mcpManager.activate(workspace);
  const final = await app.mcpManager.overview(workspace.id);
  expect(final.servers.find((s) => s.scope === "project")?.status).toBe(
    "connected",
  );
});
it("JSON 错误保留有效配置，文件并发修改不被覆盖，项目配置路径不能跳出项目", async () => {
  const service = await fixture();
  const target = { scope: "user" as const };
  const old = await save(target, {
    mcpServers: { echo: { url: service.url } },
  });
  await writeFile(old.path, '{"mcpServers": {"secret": "do-not-echo"');
  const broken = await app.mcpManager.config(target);
  expect(broken.error).toContain("JSON 格式错误");
  expect(JSON.stringify(broken)).not.toContain("do-not-echo");
  expect(broken.appliedDocument?.mcpServers.echo).toBeDefined();
  await expect(
    app.mcpManager.save({
      ...target,
      expectedRevision: old.revision,
      document: { mcpServers: {} },
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  const workspace = await project("linked");
  await symlink(join(root, "data"), join(workspace.path, ".myagent"));
  await expect(
    app.mcpManager.config({ scope: "project", workspaceId: workspace.id }),
  ).rejects.toMatchObject({ code: "protected_path" });
});
it("同一用户级服务在两个项目的目录和断连状态独立", async () => {
  const service = await fixture();
  const a = await project("a");
  const b = await project("b");
  await save({ scope: "user" }, { mcpServers: { echo: { url: service.url } } });
  await app.mcpManager.activate(a);
  await app.mcpManager.activate(b);
  const connection = app.store.execution.list("connections")[0];
  expect(connection).toBeDefined();
  const descriptors = app.registry
    .descriptors()
    .filter((d) => d.source.kind === "mcp");
  expect(descriptors).toHaveLength(2);
  expect(new Set(descriptors.map((d) => d.name)).size).toBe(2);
  await app.mcp.disconnect(connection?.id as string, a.id);
  expect(app.mcp.state(connection?.id as string, a.id).status).toBe(
    "disconnected",
  );
  expect(app.mcp.state(connection?.id as string, b.id).status).toBe(
    "connected",
  );
  expect(
    app.registry.descriptors().filter((d) => d.source.kind === "mcp"),
  ).toHaveLength(1);
});
it("旧连接迁移保留身份与允许工作区，重启不会沿用已连接状态", async () => {
  const service = await fixture();
  const workspace = await project("migration");
  const old = await app.mcpSettings.save({
    name: "legacy",
    transport: "http",
    url: service.url,
    auth: "none",
    workspaceIds: [workspace.id],
  });
  await app.server.close();
  app = await buildServer({
    dataDir: join(root, "data"),
    workspaceRoot: join(root, "defaults"),
    serveWeb: false,
  });
  const migrated = app.store.execution.get("connections", old.id);
  expect(migrated?.source?.scope).toBe("user");
  expect(migrated?.allowedWorkspaces).toEqual([workspace.id]);
  expect(app.mcp.state(old.id, workspace.id).status).toBe("disconnected");
  const diagnostic = await app.mcpManager.overview();
  expect(diagnostic.servers[0]?.status).toBe("disconnected");
  await app.mcpManager.activate(workspace);
  expect(app.mcp.state(old.id, workspace.id).status).toBe("connected");
});

it("配置文件已替换但响应失败时，提交日志恢复凭证与稳定连接身份", async () => {
  const service = await fixture();
  const target = { scope: "user" as const };
  const old = await app.mcpManager.config(target);
  const original = app.mcpManager.files.write.bind(app.mcpManager.files);
  app.mcpManager.files.write = async (...args) => {
    await original(...args);
    throw new Error("simulated-after-rename");
  };
  await expect(
    app.mcpManager.save({
      ...target,
      expectedRevision: old.revision,
      document: {
        mcpServers: {
          echo: {
            url: service.url,
            env: { TEST_SECRET: "recoverable-secret" },
          },
        },
      },
      convertSecrets: true,
    }),
  ).rejects.toThrow("simulated-after-rename");
  expect(app.store.execution.get("mcpFiles", "user")?.staged).toBeDefined();
  app.mcpManager.files.write = original;
  const recovered = await app.mcpManager.config(target);
  expect(recovered.error).toBeNull();
  expect(recovered.document?.mcpServers.echo).toBeDefined();
  expect(app.store.execution.get("mcpFiles", "user")?.staged).toBeUndefined();
  const connection = app.store.execution.list("connections")[0];
  expect(connection?.environmentRefs.TEST_SECRET).toBeTruthy();
  expect(JSON.stringify(recovered)).not.toContain("recoverable-secret");
});
it("项目确认后再次修改文件会立即阻止旧工具；停止连接不能重放远端调用", async () => {
  const service = await fixture();
  const workspace = await project("changed");
  const target = { scope: "project" as const, workspaceId: workspace.id };
  await save(target, { mcpServers: { echo: { url: service.url } } });
  await app.mcpManager.activate(workspace);
  const connection = app.store.execution.list("connections")[0];
  const descriptor = app.registry
    .descriptors()
    .find((d) => d.source.kind === "mcp");
  expect(descriptor).toBeDefined();
  const context = {
    runId: "fixture",
    sessionId: "fixture",
    stepId: "fixture",
    invocationId: randomUUID(),
    workspace,
  };
  const prepared = await app.registry.prepare(
    descriptor?.name as string,
    JSON.stringify({ text: "hang" }),
    context,
  );
  const request = {
    context,
    prepared,
    attemptId: randomUUID(),
    authorizedResources: prepared.resources,
    timeoutMs: 30000,
  };
  const call = app.mcp.call(request, new AbortController().signal);
  const rejection = expect(call).rejects.toBeDefined();
  await expect.poll(() => service.calls.length).toBe(1);
  await save(target, {
    mcpServers: { echo: { url: service.url, enabled: false } },
  });
  await rejection;
  expect(service.calls).toHaveLength(1);
  expect(app.mcp.state(connection?.id as string, workspace.id).status).toBe(
    "disconnected",
  );
  await writeFile(
    join(workspace.path, ".myagent", "mcp.json"),
    JSON.stringify({ mcpServers: { echo: { url: service.url } } }),
  );
  await expect(
    app.mcp.call(request, new AbortController().signal),
  ).rejects.toMatchObject({ code: "mcp_disabled" });
  expect(service.calls).toHaveLength(1);
});

it("修改单个服务不重连无关服务，项目文件仅排版变化不重新要求确认", async () => {
  const service = await fixture();
  const workspace = await project("stable");
  const target = { scope: "project" as const, workspaceId: workspace.id };
  const document = {
    mcpServers: { first: { url: service.url }, second: { url: service.url } },
  };
  await save(target, document);
  await app.mcpManager.activate(workspace);
  const second = app.store.execution
    .list("connections")
    .find((c) => c.name === "second");
  const requests = service.initializeCount;
  await save(target, {
    mcpServers: {
      first: { url: service.url, enabled: false },
      second: { url: service.url },
    },
  });
  expect(
    app.store.execution.get("connections", second?.id as string)?.revision,
  ).toBe(second?.revision);
  expect(app.mcp.state(second?.id as string, workspace.id).status).toBe(
    "connected",
  );
  expect(service.initializeCount).toBe(requests);
  const view = await app.mcpManager.config(target);
  await writeFile(view.path, JSON.stringify(view.document));
  const reformatted = await app.mcpManager.config(target);
  expect(reformatted.pending).toBe(false);
  expect(service.initializeCount).toBe(requests);
});
