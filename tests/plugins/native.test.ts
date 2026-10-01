/** 插件原生闭环：真实 Skill 快照、stdio MCP 和 Hook 拒绝，不把协议替身称为真实模型验收。 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import type { ModelPort } from "../../packages/kernel/src/index.js";

it.runIf(process.env.MYAGENT_TEST_NATIVE === "1")(
  "报告插件三类组件在原生沙箱闭环，禁用后新 Run 不继承",
  async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "myagent-plugin-native-")),
    );
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    let n = 0;
    let skillId = "";
    let mcpName = "";
    const model: ModelPort = {
      async *stream() {
        const actions = [
          { name: "load_skill", arguments: { id: skillId } },
          { name: mcpName, arguments: {} },
          {
            name: "write_file",
            arguments: {
              path: "bad.md",
              content: "收入 2000",
              expectedHash: null,
            },
          },
          {
            name: "write_file",
            arguments: {
              path: "reports/final.md",
              content: "收入 2000",
              expectedHash: null,
            },
          },
        ];
        const c = actions[n++];
        yield {
          type: "done",
          finishReason: c ? "tool_calls" : "stop",
          usage: null,
          response: {
            content: c ? "执行" : "报告完成",
            toolCalls: c
              ? [
                  {
                    id: `c${n}`,
                    name: c.name,
                    arguments: JSON.stringify(c.arguments),
                  },
                ]
              : [],
          },
        };
      },
    };
    try {
      app = await buildServer({
        dataDir: join(root, "data"),
        workspaceRoot: join(root, "work"),
        skillRoot: join(root, "skills"),
        serveWeb: false,
        modelFactory: () => model,
      });
      app.settings.save({
        baseUrl: "http://127.0.0.1:1/v1",
        apiProtocol: "responses",
        model: "fixture",
        apiKey: "fixture",
        systemPrompt: "",
        expectedRevision: 0,
      });
      const session = await app.projects.create({
        requestId: crypto.randomUUID(),
      });
      let j = await app.plugins.preview({
        scope: "project",
        workspaceId: session.workspaceId!,
        requestId: crypto.randomUUID(),
        action: "install",
        expectedRevision: 0,
        enabled: true,
        source: { kind: "local", path: resolve("plugins/report-assistant") },
      });
      await expect
        .poll(() => {
          j = app!.plugins.job(j.id);
          return j.status;
        })
        .toBe("ready");
      const plugin = await app.plugins.confirm(j.id, {
        requestId: crypto.randomUUID(),
        confirmation: j.confirmation!,
      });
      const connection = app.store.execution
        .list("connections")
        .find((c) => c.plugin)!;
      expect(app.mcp.state(connection.id, session.workspaceId!).status).toBe(
        "connected",
      );
      skillId = app.skills
        .catalog(session.workspaceId!)
        .entries.find((e) => e.plugin)!.id;
      mcpName = app.registry
        .descriptors()
        .find(
          (d) =>
            d.source.kind === "mcp" && d.source.connectionId === connection.id,
        )!.name;
      // 测试通过管理服务选择 direct，确保真正调用的定义与 Run 固定目录相同。
      const config = await app.plugins.preview({
        scope: "project",
        workspaceId: session.workspaceId!,
        requestId: crypto.randomUUID(),
        pluginId: plugin.pluginId,
        action: "configure",
        expectedRevision: plugin.revision,
        enabled: true,
        selection: {
          excluded: [],
          mcp: {
            "mcp:sales": {
              ...plugin.manifest.components.find((c) => c.mcp)!.mcp!,
              toolExposure: "direct",
            },
          },
        },
      });
      await expect.poll(() => app!.plugins.job(config.id).status).toBe("ready");
      const enabled = await app.plugins.confirm(config.id, {
        requestId: crypto.randomUUID(),
        confirmation: app.plugins.job(config.id).confirmation!,
      });
      mcpName = app.registry
        .descriptors()
        .find(
          (d) =>
            d.source.kind === "mcp" &&
            app!.plugins.allows(d.source.connectionId!, session.workspaceId!),
        )!.name;
      const run = app.chat.start(session.id, {
        requestId: crypto.randomUUID(),
        expectedRevision: session.revision,
        content: "生成销售报告",
      }).run;
      await expect
        .poll(
          async () => {
            for (const a of app!.store.execution
              .list("approvals", { runId: run.id })
              .filter((a) => a.status === "pending"))
              await app!.server.inject({
                method: "POST",
                url: `/api/v1/approvals/${a.id}/decision`,
                payload: {
                  requestId: crypto.randomUUID(),
                  decision: "allow",
                  scope: "once",
                },
              });
            return app!.store.getRun(run.id).status;
          },
          { timeout: 40000 },
        )
        .not.toMatch(/^(queued|running|waiting_approval|cleaning)$/);
      expect(app.store.getRun(run.id).status).toBe("succeeded");
      expect(
        readFileSync(
          join(app.toolSystem.workspace(session.id)!.path, "reports/final.md"),
          "utf8",
        ),
      ).toContain("2000");
      expect(
        app.hooks
          .records(session.id)
          .some((h) => h.plugin && h.status === "denied"),
      ).toBe(true);
      expect(
        (app.store.snapshot(session.id).steps ?? [])
          .flatMap((s) => s.tools)
          .filter((t) => t.result?.ok),
      ).toHaveLength(3);
      await app.plugins.change(enabled.pluginId, {
        scope: "project",
        workspaceId: session.workspaceId!,
        requestId: crypto.randomUUID(),
        expectedRevision: enabled.revision,
        action: "disable",
      });
      expect(app.plugins.skillSources(session.workspaceId!)).toHaveLength(0);
    } finally {
      await app?.server.close();
      app?.plugins.files.collect(new Set());
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
