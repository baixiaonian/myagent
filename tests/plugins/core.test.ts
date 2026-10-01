/** 插件集成验收：真实文件/SQLite 与 HTTP 边界；模型和网关替身仅验证流程，原生沙箱另测。 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import type {
  PluginJob,
  PluginMutation,
} from "../../packages/contracts/src/index.js";
import { parsePluginManifest } from "../../packages/extensions/src/index.js";

let app: Awaited<ReturnType<typeof buildServer>> | undefined;
const roots: string[] = [];
afterEach(async () => {
  await app?.server.close();
  app?.plugins.files.collect(new Set());
  app = undefined;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "myagent-plugins-")));
  roots.push(root);
  const pkg = join(root, "package");
  mkdirSync(join(pkg, "skills", "report"), { recursive: true });
  writeFileSync(
    join(pkg, "plugin.json"),
    JSON.stringify({ name: "example", version: "1", description: "示例" }),
  );
  writeFileSync(
    join(pkg, "skills/report/SKILL.md"),
    "---\nname: report\ndescription: 测试中文报告\n---\n\n报告必须包含验证结果。",
  );
  app = await buildServer({
    dataDir: join(root, "data"),
    workspaceRoot: join(root, "work"),
    skillRoot: join(root, "skills"),
    serveWeb: false,
    modelFactory: () => ({
      async *stream() {
        yield {
          type: "done",
          finishReason: "stop",
          usage: null,
          response: { content: "完成", toolCalls: [] },
        };
      },
    }),
  });
  app.settings.save({
    baseUrl: "http://127.0.0.1:1/v1",
    apiProtocol: "responses",
    model: "fixture",
    apiKey: "test-only",
    systemPrompt: "",
    expectedRevision: 0,
  });
  const session = await app.projects.create({ requestId: crypto.randomUUID() });
  return { root, pkg, session };
}
async function ready(
  input: Partial<PluginMutation> & { source?: PluginMutation["source"] },
): Promise<PluginJob> {
  let job = await app!.plugins.preview({
    scope: "user",
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    action: "install",
    enabled: true,
    ...input,
  });
  for (let n = 0; n < 150 && job.status === "preparing"; n++) {
    await new Promise((r) => setTimeout(r, 10));
    job = app!.plugins.job(job.id);
  }
  return job;
}
async function confirm(job: PluginJob) {
  expect(job.error).toBeNull();
  expect(job.status).toBe("ready");
  return app!.plugins.confirm(job.id, {
    requestId: crypto.randomUUID(),
    confirmation: job.confirmation!,
  });
}
it("本地安装不可变快照，技能可用，不写手工配置，重复确认不重复发布", async () => {
  const { root, pkg, session } = await setup();
  const input = {
    scope: "user" as const,
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    action: "install" as const,
    enabled: true,
    source: { kind: "local" as const, path: pkg },
  };
  const job = await ready(input);
  expect((await app!.plugins.preview(input)).id).toBe(job.id);
  const command = {
    requestId: crypto.randomUUID(),
    confirmation: job.confirmation!,
  };
  const value = await app!.plugins.confirm(job.id, command);
  expect((await app!.plugins.confirm(job.id, command)).revision).toBe(
    value.revision,
  );
  expect(
    app!.skills
      .catalog(session.workspaceId!)
      .entries.some((e) => e.plugin?.pluginId === value.pluginId),
  ).toBe(true);
  expect(existsSync(join(root, "data", "hooks.json"))).toBe(false);
  expect(existsSync(join(root, "data", "mcp.json"))).toBe(false);
  writeFileSync(join(pkg, "skills/report/SKILL.md"), "changed");
  expect(
    app!.skills.catalog(session.workspaceId!).entries.find((e) => e.plugin)
      ?.error,
  ).toBeNull();
});
it("用户级继承、项目禁用和移除不回退，恢复继承显式生效", async () => {
  const { pkg, session } = await setup();
  const p = await confirm(
    await ready({ source: { kind: "local", path: pkg } }),
  );
  const target = {
    scope: "project" as const,
    workspaceId: session.workspaceId!,
  };
  expect(app!.plugins.list(target)[0]?.inherited).toBe(true);
  await app!.plugins.change(p.pluginId, {
    ...target,
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    action: "uninstall",
  });
  expect(
    app!.skills.catalog(target.workspaceId).entries.filter((e) => e.plugin),
  ).toHaveLength(0);
  await app!.plugins.change(p.pluginId, {
    ...target,
    requestId: crypto.randomUUID(),
    expectedRevision: 1,
    action: "inherit",
  });
  expect(
    app!.skills.catalog(target.workspaceId).entries.filter((e) => e.plugin),
  ).toHaveLength(1);
});
it("Run 冻结旧版本，更新和卸载后只能旧 Run 继续访问", async () => {
  const { pkg, session } = await setup();
  const p = await confirm(
    await ready({ source: { kind: "local", path: pkg } }),
  );
  const run = app!.store.beginRun({
    sessionId: session.id,
    expectedRevision: session.revision,
    requestId: crypto.randomUUID(),
    fingerprint: "fixture",
    kind: "send",
    content: "报告",
    model: "fixture",
    apiProtocol: "responses",
    contextTrimmed: false,
  });
  app!.plugins.initialize(run);
  app!.skills.initialize(run.id, "报告");
  writeFileSync(
    join(pkg, "plugin.json"),
    JSON.stringify({ name: "example", version: "2" }),
  );
  const update = await confirm(
    await ready({
      action: "update",
      pluginId: p.pluginId,
      expectedRevision: p.revision,
    }),
  );
  expect(update.version).not.toBe(p.version);
  expect(app!.plugins.references(run.id)[0]?.version).toBe(p.version);
  const old = app!.plugins.skillSources(session.workspaceId!, run.id);
  await app!.plugins.change(p.pluginId, {
    scope: "user",
    requestId: crypto.randomUUID(),
    expectedRevision: update.revision,
    action: "uninstall",
  });
  expect(app!.plugins.skillSources(session.workspaceId!)).toHaveLength(0);
  expect(app!.plugins.skillSources(session.workspaceId!, run.id)).toEqual(old);
  expect(app!.plugins.list({ scope: "user" })[0]?.status).toBe(
    "pending_cleanup",
  );
});
it("版本冲突、不兼容 Hook 和取消不能启用", async () => {
  const { pkg } = await setup();
  mkdirSync(join(pkg, "hooks"));
  writeFileSync(join(pkg, "hooks/hooks.json"), "{}");
  const job = await ready({ source: { kind: "local", path: pkg } });
  await expect(confirm(job)).rejects.toMatchObject({
    code: "plugin_incompatible",
  });
  const cancelled = app!.plugins.cancel(job.id);
  expect(cancelled.status).toBe("cancelled");
  await expect(
    app!.plugins.confirm(job.id, {
      requestId: crypto.randomUUID(),
      confirmation: job.confirmation!,
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  const allowed = await ready({
    source: { kind: "local", path: pkg },
    selection: { excluded: ["external:hooks"], mcp: {} },
  });
  const p = await confirm(allowed);
  await expect(
    app!.plugins.change(p.pluginId, {
      scope: "user",
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      action: "disable",
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
});
it("同名不同来源保持独立身份；回退恢复上版", async () => {
  const { pkg, root } = await setup();
  const one = await confirm(
    await ready({ source: { kind: "local", path: pkg } }),
  );
  const second = join(root, "other");
  mkdirSync(second);
  writeFileSync(
    join(second, "plugin.json"),
    JSON.stringify({ name: "example", commands: ["unsupported"] }),
  );
  const two = await confirm(
    await ready({ source: { kind: "local", path: second }, enabled: false }),
  );
  expect(one.pluginId).not.toBe(two.pluginId);
  writeFileSync(
    join(pkg, "plugin.json"),
    JSON.stringify({ name: "example", version: "2" }),
  );
  const v2 = await confirm(
    await ready({
      action: "update",
      pluginId: one.pluginId,
      expectedRevision: one.revision,
    }),
  );
  const back = await confirm(
    await ready({
      action: "rollback",
      pluginId: one.pluginId,
      expectedRevision: v2.revision,
    }),
  );
  expect(back.version).toBe(one.version);
});
it("拒绝包内链接及受保护目录，不运行入口代码", async () => {
  const { pkg, root } = await setup();
  writeFileSync(
    join(pkg, "evil.mjs"),
    `require('fs').writeFileSync('${root}/should-not-exist','x')`,
  );
  const good = await ready({ source: { kind: "local", path: pkg } });
  expect(good.status).toBe("ready");
  expect(existsSync(join(root, "should-not-exist"))).toBe(false);
  symlinkSync("/etc/passwd", join(pkg, "escape"));
  expect((await ready({ source: { kind: "local", path: pkg } })).status).toBe(
    "failed",
  );
  expect(
    (await ready({ source: { kind: "local", path: join(root, "data") } }))
      .status,
  ).toBe("failed");
});
it("原生 Hook 预览捕获，授权和 Run 引用带插件身份", async () => {
  const { pkg, session } = await setup();
  mkdirSync(join(pkg, "scripts"));
  writeFileSync(
    join(pkg, "scripts/check.mjs"),
    'console.log(JSON.stringify({decision:"continue"}));',
  );
  writeFileSync(
    join(pkg, "plugin.json"),
    JSON.stringify({
      name: "example",
      extensions: {
        "com.myagent": { apiVersion: 1, hooks: "./myagent-hooks.json" },
      },
    }),
  );
  writeFileSync(
    join(pkg, "myagent-hooks.json"),
    JSON.stringify({
      schemaVersion: 1,
      hooks: [
        {
          id: "check",
          event: "RunStart",
          enabled: true,
          packagePath: "scripts",
          entry: "check.mjs",
          interpreter: "node",
          args: [],
          permissions: { writePaths: [], networkDomains: [] },
          timeoutMs: 1000,
        },
      ],
    }),
  );
  const p = await confirm(
    await ready({ source: { kind: "local", path: pkg } }),
  );
  const run = app!.store.beginRun({
    sessionId: session.id,
    expectedRevision: session.revision,
    requestId: crypto.randomUUID(),
    fingerprint: "fixture",
    kind: "send",
    content: "报告",
    model: "fixture",
    contextTrimmed: false,
  });
  app!.plugins.initialize(run);
  app!.hooks.initialize(run);
  expect(app!.hooks.store.get("runs", run.id)?.hooks[0]?.plugin?.pluginId).toBe(
    p.pluginId,
  );
  app!.hooks.collect();
  expect(app!.hooks.store.get("runs", run.id)?.hooks).toHaveLength(1);
});
it("HTTP 管理错误和读取不包含秘密，不创建会话", async () => {
  await setup();
  const before = app!.store.listSessions().length;
  const response = await app!.server.inject({
    method: "POST",
    url: "/api/v1/plugins/preview",
    payload: {
      scope: "user",
      requestId: "x",
      expectedRevision: 0,
      action: "install",
      enabled: true,
      source: { kind: "git", url: "https://secret:password@github.com/a/b" },
    },
  });
  expect(response.statusCode).toBe(400);
  expect(response.body).not.toContain("password");
  expect(app!.store.listSessions().length).toBe(before);
});
it("兼容清单路径、MCP 传输与未知执行声明逐项报告", () => {
  const files = new Map([
    [
      ".codex-plugin/plugin.json",
      JSON.stringify({
        name: "compat",
        skills: "./skills",
        mcpServers: "./.mcp.json",
        apps: "./.app.json",
      }),
    ],
    [
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          docs: { type: "streamable-http", url: "https://example.com/mcp" },
        },
      }),
    ],
  ]);
  const value = parsePluginManifest(files, ["skills/report/SKILL.md"]);
  expect(value.components.find((c) => c.kind === "mcp")?.mcp?.transport).toBe(
    "http",
  );
  expect(value.issues[0]?.componentId).toBe("external:apps");
  expect(() =>
    parsePluginManifest(
      new Map([
        [".codex-plugin/plugin.json", '{"name":"bad","skills":"../outside"}'],
      ]),
      [],
    ),
  ).toThrow();
});
it("重启恢复已安装版本，不将插件 MCP 迁入用户文件", async () => {
  const { pkg, root } = await setup();
  const p = await confirm(
    await ready({ source: { kind: "local", path: pkg } }),
  );
  await app!.server.close();
  app = await buildServer({ dataDir: join(root, "data"), serveWeb: false });
  expect(app.plugins.list({ scope: "user" })[0]?.version).toBe(p.version);
  expect(existsSync(join(root, "data", "mcp.json"))).toBe(false);
  expect(readFileSync(join(pkg, "plugin.json"), "utf8")).toContain("example");
});

it("插件 MCP 通过真实 HTTP 发现目录，更新与卸载保留旧 Run 的连接", async () => {
  const { mcpFixture } = await import("../execution/mcp-fixture.js");
  const remote = await mcpFixture();
  try {
    const { pkg, session } = await setup();
    writeFileSync(
      join(pkg, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: { type: "http", url: remote.url, toolExposure: "direct" },
        },
      }),
    );
    const p = await confirm(
      await ready({ source: { kind: "local", path: pkg } }),
    );
    const old = app!.store.execution
      .list("connections")
      .find((c) => c.plugin?.pluginId === p.pluginId)!;
    expect(app!.mcp.state(old.id, session.workspaceId!).status).toBe(
      "connected",
    );
    const run = app!.store.beginRun({
      sessionId: session.id,
      expectedRevision: session.revision,
      requestId: crypto.randomUUID(),
      fingerprint: "mcp",
      kind: "send",
      content: "echo",
      model: "fixture",
      contextTrimmed: false,
    });
    app!.plugins.initialize(run);
    writeFileSync(
      join(pkg, "plugin.json"),
      JSON.stringify({ name: "example", version: "2" }),
    );
    const next = await confirm(
      await ready({
        action: "update",
        pluginId: p.pluginId,
        expectedRevision: p.revision,
      }),
    );
    const current = app!.store.execution
      .list("connections")
      .find((c) => c.plugin?.pluginId === p.pluginId && c.id !== old.id)!;
    expect(app!.plugins.allows(old.id, session.workspaceId!, run.id)).toBe(
      true,
    );
    expect(app!.plugins.allows(current.id, session.workspaceId!, run.id)).toBe(
      false,
    );
    expect(app!.plugins.allows(old.id, session.workspaceId!)).toBe(false);
    await expect(
      app!.mcpManager.removeConnection(old.id),
    ).rejects.toMatchObject({ code: "plugin_managed" });
    await app!.plugins.change(p.pluginId, {
      scope: "user",
      requestId: crypto.randomUUID(),
      expectedRevision: next.revision,
      action: "uninstall",
    });
    expect(app!.mcp.state(old.id, session.workspaceId!).status).toBe(
      "connected",
    );
    expect(app!.store.execution.get("connections", current.id)).toBeNull();
    const descriptor = app!.registry
      .descriptors()
      .find(
        (t) => t.source.kind === "mcp" && t.source.connectionId === old.id,
      )!;
    const context = {
      runId: run.id,
      sessionId: session.id,
      stepId: "test",
      invocationId: "test",
      workspace: app!.toolSystem.workspace(session.id),
    };
    const prepared = await app!.registry.prepare(
      descriptor.name,
      JSON.stringify({ text: "旧版本可用" }),
      context,
    );
    const result = await app!.mcp.call(
      {
        attemptId: "test",
        prepared,
        context,
        timeoutMs: 1000,
        authorizedResources: prepared.resources,
      },
      new AbortController().signal,
    );
    expect(JSON.stringify(result)).toContain("旧版本可用");
  } finally {
    await remote.close();
  }
});

it("确认期间取消不会从旧预览复活安装", async () => {
  const { pkg } = await setup();
  const job = await ready({ source: { kind: "local", path: pkg } });
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  vi.spyOn(
    Reflect.get(app!.plugins, "hookFiles") as { capture: () => Promise<void> },
    "capture",
  ).mockImplementation(async () => {
    entered();
    await new Promise<void>((r) => {
      release = r;
    });
  });
  const pending = confirm(job);
  await waiting;
  app!.plugins.cancel(job.id);
  release();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  expect(app!.plugins.list({ scope: "user" })).toHaveLength(0);
});

it("无变化不推进版本；运行副本插入文件后拒绝新 Run", async () => {
  const { pkg, session } = await setup();
  const p = await confirm(
    await ready({ source: { kind: "local", path: pkg } }),
  );
  const j = await ready({
    action: "update",
    pluginId: p.pluginId,
    expectedRevision: p.revision,
  });
  expect(j.noChange).toBe(true);
  expect((await confirm(j)).revision).toBe(p.revision);
  const v = app!.plugins.store.list("versions")[0]!;
  const { chmodSync } = await import("node:fs");
  chmodSync(v.package.runtimePath, 0o700);
  writeFileSync(join(v.package.runtimePath, "injected.mjs"), "process.exit(0)");
  const run = app!.store.beginRun({
    sessionId: session.id,
    expectedRevision: session.revision,
    requestId: crypto.randomUUID(),
    fingerprint: "mutated",
    kind: "send",
    content: "hi",
    model: "fixture",
    contextTrimmed: false,
  });
  expect(() => app!.plugins.initialize(run)).toThrow("运行副本变化");
});
it("发布意图后数据库失败，重启保留原版并允许重新预览", async () => {
  const { pkg, root } = await setup();
  const p = await confirm(
    await ready({ source: { kind: "local", path: pkg } }),
  );
  writeFileSync(
    join(pkg, "plugin.json"),
    JSON.stringify({ name: "example", version: "2" }),
  );
  const j = await ready({
    action: "update",
    pluginId: p.pluginId,
    expectedRevision: p.revision,
  });
  const store = app!.plugins.store,
    put = store.put.bind(store);
  const fault = vi.spyOn(store, "put").mockImplementation((kind, value) => {
    if (kind === "bindings") throw new Error("fixture commit failure");
    put(kind, value);
  });
  await expect(confirm(j)).rejects.toThrow("fixture");
  fault.mockRestore();
  expect(app!.plugins.list({ scope: "user" })[0]?.version).toBe(p.version);
  await app!.server.close();
  app = await buildServer({ dataDir: join(root, "data"), serveWeb: false });
  expect(app.plugins.job(j.id).status).toBe("interrupted");
  expect(app.plugins.list({ scope: "user" })[0]?.version).toBe(p.version);
});
it("无效 Skill 元信息可明确排除，不能静默启用", async () => {
  const { pkg } = await setup();
  writeFileSync(join(pkg, "skills/report/SKILL.md"), "无 YAML 元信息");
  const j = await ready({ source: { kind: "local", path: pkg } });
  expect(
    j.manifest?.issues.some((i) => i.componentId === "skill:skills/report"),
  ).toBe(true);
  await expect(confirm(j)).rejects.toMatchObject({
    code: "plugin_incompatible",
  });
});
it("v9 升级为 v10 保持旧会话，不自动创建插件", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { root, session } = await setup();
  await app!.server.close();
  const file = join(root, "data/state.db");
  let db = new DatabaseSync(file);
  db.exec(
    "DROP TABLE observation_records; DROP TABLE observation_settings; DROP TABLE observation_operations; DROP TABLE team_records; ALTER TABLE sessions DROP COLUMN parent_session_id; ALTER TABLE messages DROP COLUMN origin; DROP TABLE plugin_records; PRAGMA user_version=9",
  );
  db.close();
  app = await buildServer({ dataDir: join(root, "data"), serveWeb: false });
  expect(app.store.snapshot(session.id).session.id).toBe(session.id);
  expect(app.plugins.list({ scope: "user" })).toHaveLength(0);
  db = new DatabaseSync(file);
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(13);
  db.close();
});

it("配置预览拒绝明文认证材料且不留下失败任务泄漏", async () => {
  const { pkg } = await setup();
  await expect(
    app!.plugins.preview({
      scope: "user",
      requestId: "secret-preview",
      action: "install",
      source: { kind: "local", path: pkg },
      expectedRevision: 0,
      enabled: true,
      selection: {
        excluded: [],
        mcp: { "mcp:x": { token: "PLUGIN_SECRET_CANARY" } },
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_plugin" });
  expect(JSON.stringify(app!.plugins.jobs({ scope: "user" }))).not.toContain(
    "PLUGIN_SECRET_CANARY",
  );
});
it("MCP 配置版本、工作区和凭证撤销分别核验", async () => {
  const { pkg, session } = await setup();
  const { mcpFixture } = await import("../execution/mcp-fixture.js");
  const remote = await mcpFixture({ oauth: true });
  try {
    writeFileSync(
      join(pkg, "mcp.json"),
      JSON.stringify({
        mcpServers: { echo: { type: "http", url: remote.url, auth: "token" } },
      }),
    );
    const j = await ready({ source: { kind: "local", path: pkg } });
    const p = await app!.plugins.confirm(j.id, {
      requestId: "with-secret",
      confirmation: j.confirmation!,
      credentials: { "mcp:echo": { token: "mcp-fixture-access" } },
    });
    expect(JSON.stringify(p)).not.toContain("mcp-fixture-access");
    const c = app!.store.execution.list("connections").find((c) => c.plugin)!;
    expect(app!.plugins.allows(c.id, "not-this-project")).toBe(false);
    const run = app!.store.beginRun({
      sessionId: session.id,
      expectedRevision: session.revision,
      requestId: crypto.randomUUID(),
      fingerprint: "auth",
      kind: "send",
      content: "auth",
      model: "fixture",
      contextTrimmed: false,
    });
    app!.plugins.initialize(run);
    const cleared = await ready({
      action: "configure",
      pluginId: p.pluginId,
      expectedRevision: p.revision,
    });
    await app!.plugins.confirm(cleared.id, {
      requestId: "clear",
      confirmation: cleared.confirmation!,
      credentials: { "mcp:echo": { token: "" } },
    });
    expect(() =>
      app!.plugins.guard(c.id, session.workspaceId!, run.id),
    ).toThrow("凭证已撤销");
  } finally {
    await remote.close();
  }
});
it("项目恢复继承保留修订号，旧安装预览不能在 ABA 后生效", async () => {
  const { pkg, session } = await setup();
  const p = await confirm(
    await ready({ source: { kind: "local", path: pkg } }),
  );
  const target = {
    scope: "project" as const,
    workspaceId: session.workspaceId!,
  };
  const stale = await ready({
    ...target,
    action: "configure",
    pluginId: p.pluginId,
    expectedRevision: 0,
  });
  await app!.plugins.change(p.pluginId, {
    ...target,
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    action: "disable",
  });
  await app!.plugins.change(p.pluginId, {
    ...target,
    requestId: crypto.randomUUID(),
    expectedRevision: 1,
    action: "inherit",
  });
  expect(app!.plugins.list(target)[0]?.revision).toBe(2);
  await expect(confirm(stale)).rejects.toMatchObject({
    code: "revision_conflict",
  });
  const fresh = await ready({
    ...target,
    action: "configure",
    pluginId: p.pluginId,
    expectedRevision: 2,
  });
  expect((await confirm(fresh)).enabled).toBe(true);
});

it("插件凭证环境变量沿用执行加载器限制，不能通过确认绕过", async () => {
  const { pkg } = await setup();
  writeFileSync(
    join(pkg, "mcp.json"),
    JSON.stringify({
      mcpServers: { server: { command: "node", args: ["server.mjs"] } },
    }),
  );
  const j = await ready({ source: { kind: "local", path: pkg } });
  await expect(
    app!.plugins.confirm(j.id, {
      requestId: "forbidden-env",
      confirmation: j.confirmation!,
      credentials: {
        "mcp:server": {
          environment: { NODE_OPTIONS: "--require /tmp/untrusted.js" },
        },
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_environment" });
  expect(app!.plugins.list({ scope: "user" })).toHaveLength(0);
  expect(app!.plugins.store.list("credentials")).toHaveLength(0);
});

it("插件 Skill 的包根变量绑定本轮只读副本，不展开其他宿主变量", async () => {
  const { pkg, session } = await setup();
  writeFileSync(
    join(pkg, "skills/report/SKILL.md"),
    "---\nname: report\ndescription: 测试\n---\n读取 ${PLUGIN_ROOT}/assets/template.txt；不要展开 ${HOME}。",
  );
  mkdirSync(join(pkg, "assets"));
  writeFileSync(join(pkg, "assets/template.txt"), "报告模板");
  await confirm(await ready({ source: { kind: "local", path: pkg } }));
  const entry = app!.skills
    .catalog(session.workspaceId!)
    .entries.find((e) => e.plugin)!;
  const run = app!.store.beginRun({
    sessionId: session.id,
    expectedRevision: session.revision,
    requestId: crypto.randomUUID(),
    fingerprint: "root",
    kind: "send",
    content: "模板",
    model: "fixture",
    contextTrimmed: false,
  });
  app!.plugins.initialize(run);
  app!.skills.initialize(run.id, "模板", [entry.id]);
  const prepared = await app!.skills.prepare(
    run.id,
    20000,
    new AbortController().signal,
  );
  const content = JSON.stringify(prepared.messages);
  expect(content).toContain(entry.plugin!.rootPath);
  expect(content).not.toContain("${PLUGIN_ROOT}");
  expect(content).toContain("${HOME}");
  expect(app!.plugins.readPaths(run.id)).toContain(entry.plugin!.rootPath);
});

it("删除后的未解决执行事实保守阻止包和连接物理回收", async () => {
  const { pkg, session } = await setup();
  const p = await confirm(
    await ready({ source: { kind: "local", path: pkg } }),
  );
  const version = app!.plugins.store.list("versions")[0]!;
  app!.store.execution.put("concerns", {
    id: "unknown-deleted",
    workspaceId: session.workspaceId!,
    sourceSessionId: session.id,
    toolName: "fixture side effect",
    source: { kind: "local" },
    resources: [],
    createdAt: new Date().toISOString(),
  });
  await app!.plugins.change(p.pluginId, {
    scope: "user",
    requestId: crypto.randomUUID(),
    expectedRevision: p.revision,
    action: "uninstall",
  });
  expect(app!.plugins.list({ scope: "user" })[0]?.status).toBe(
    "pending_cleanup",
  );
  expect(existsSync(version.package.runtimePath)).toBe(true);
});
