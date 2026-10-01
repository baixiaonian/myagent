/** 插件双协议真实验收：只读既有凭证，在临时实例验证真实模型调整工具操作；原设置与历史不修改。 */
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildServer } from "../apps/server/dist/bootstrap/index.js";
import {
  FileCredentialStore,
  OpenAIChatModel,
  OpenAIResponsesModel,
} from "../packages/adapters/dist/index.js";

const require = createRequire(
    new URL("../packages/adapters/package.json", import.meta.url),
  ),
  Database = require("better-sqlite3");
const source = resolve(
  process.env.MYAGENT_SOURCE_DATA_DIR ?? join(homedir(), ".myagent"),
);
function original() {
  const db = new Database(join(source, "state.db"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return db.prepare("SELECT data FROM settings WHERE id=1").get().data;
  } finally {
    db.close();
  }
}
const before = original(),
  config = JSON.parse(before),
  secret = new FileCredentialStore(source).read(config.credentialRef);
assert(secret && config.model, "缺少已有授权模型连接；真实验收尚未完成。");
const report = {
  date: new Date().toISOString(),
  protocols: [],
  originalSettingsUnchanged: false,
};
for (const protocol of process.env.MYAGENT_TEST_PROTOCOL
  ? [process.env.MYAGENT_TEST_PROTOCOL]
  : ["responses", "chat_completions"]) {
  const root = mkdtempSync(join(tmpdir(), "myagent-plugin-live-")),
    pkg = join(root, "package"),
    data = join(root, "data");
  cpSync(resolve("plugins/report-assistant"), pkg, { recursive: true });
  let app,
    requests = 0;
  const evidence = {
    protocol,
    ok: false,
    requests: 0,
    approvals: 0,
    runs: [],
    error: null,
  };
  try {
    app = await buildServer({
      dataDir: data,
      workspaceRoot: join(root, "work"),
      skillRoot: join(root, "skills"),
      serveWeb: false,
      modelFactory(settings) {
        const model =
          protocol === "responses"
            ? new OpenAIResponsesModel(config.baseUrl, secret, settings.model)
            : new OpenAIChatModel(config.baseUrl, secret, settings.model);
        return {
          estimateInput: model.estimateInput?.bind(model),
          async *stream(...args) {
            requests++;
            yield* model.stream(...args);
          },
        };
      },
    });
    app.settings.save({
      baseUrl: config.baseUrl,
      model: config.model,
      apiProtocol: protocol,
      apiKey: secret,
      systemPrompt: "",
      expectedRevision: 0,
      contextWindowTokens: 200000,
      outputReserveTokens: 4096,
    });
    const session = await app.projects.create({
        requestId: crypto.randomUUID(),
      }),
      workspace = app.toolSystem.workspace(session.id);
    mkdirSync(join(workspace.path, "reports"));
    async function install(action, old) {
      let job = await app.plugins.preview({
        scope: "project",
        workspaceId: session.workspaceId,
        requestId: crypto.randomUUID(),
        action,
        expectedRevision: old?.revision ?? 0,
        enabled: true,
        ...(old
          ? { pluginId: old.pluginId }
          : { source: { kind: "local", path: pkg } }),
      });
      while (job.status === "preparing") {
        await delay(25);
        job = app.plugins.job(job.id);
      }
      assert.equal(job.status, "ready", job.error ?? "preview");
      return app.plugins.confirm(job.id, {
        requestId: crypto.randomUUID(),
        confirmation: job.confirmation,
      });
    }
    const initial = await install("install");
    async function task(content) {
      const s = app.store.snapshot(session.id).session,
        r = app.chat.start(session.id, {
          requestId: crypto.randomUUID(),
          expectedRevision: s.revision,
          content,
        }).run;
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        const current = app.store.getRun(r.id);
        for (const a of app.store.execution
          .list("approvals", { runId: r.id })
          .filter((a) => a.status === "pending")) {
          const inv = app.store.execution.get("invocations", a.invocationId);
          assert(
            inv?.source.kind === "mcp" &&
              !a.resources.some((x) => x.kind === "network"),
            "真实验收只授权本地样例 MCP，其他操作须单独核对。",
          );
          const response = await app.server.inject({
            method: "POST",
            url: `/api/v1/approvals/${a.id}/decision`,
            payload: {
              requestId: crypto.randomUUID(),
              decision: "allow",
              scope: "once",
            },
          });
          assert.equal(response.statusCode, 200);
          evidence.approvals++;
        }
        if (
          !["queued", "running", "waiting_approval", "cleaning"].includes(
            current.status,
          )
        ) {
          evidence.runs.push({
            id: r.id,
            status: current.status,
            steps: current.stepCount,
            plugins: app.plugins.references(r.id).map((p) => p.version),
          });
          assert.equal(current.status, "succeeded", current.error?.code);
          return current;
        }
        await delay(100);
      }
      await app.chat.cancel(r.id);
      throw new Error("live_deadline");
    }
    const first = await task(
      "请按可用的报告助手约定，查询样例销售数据并写成中文销售报告，保存到 reports/final.md，写完后读回核对总收入。不要执行终端命令或访问网络。",
    );
    assert(
      /2,?000/.test(
        readFileSync(join(workspace.path, "reports/final.md"), "utf8"),
      ),
      "报告未包含真实收入",
    );
    const snap = app.store.snapshot(session.id);
    evidence.firstTools = snap.steps.flatMap((s) =>
      s.tools.map((t) => ({
        name: t.name,
        ok: t.result?.ok,
        error: t.result?.error?.code,
      })),
    );
    evidence.firstHooks = app.hooks
      .records(session.id)
      .map((h) => ({ event: h.event, status: h.status }));
    assert(
      snap.steps.some((s) =>
        s.tools.some((t) => t.name === "load_skill" && t.result?.ok),
      ),
    );
    assert(
      app.store.execution
        .list("invocations", { runId: first.id })
        .some((i) => i.source.kind === "mcp" && i.status === "succeeded"),
    );
    assert(
      app.hooks
        .records(session.id)
        .some((h) => h.plugin && h.status === "succeeded"),
    );
    const manifest = JSON.parse(readFileSync(join(pkg, "plugin.json"), "utf8"));
    manifest.version = "1.1.0";
    writeFileSync(join(pkg, "plugin.json"), JSON.stringify(manifest));
    const next = await install("update", initial);
    assert.notEqual(next.version, initial.version);
    await task(
      "再按当前报告技能重新查询数据，生成 reports/updated.md。不要执行终端命令或访问网络。",
    );
    assert(
      /2,?000/.test(
        readFileSync(join(workspace.path, "reports/updated.md"), "utf8"),
      ),
      "更新报告收入错误",
    );
    assert.equal(evidence.runs.at(-1).plugins[0], next.version);
    await app.plugins.change(next.pluginId, {
      scope: "project",
      workspaceId: session.workspaceId,
      requestId: crypto.randomUUID(),
      expectedRevision: next.revision,
      action: "disable",
    });
    await task("本次不用任何工具，只回复：已停用。");
    assert.equal(evidence.runs.at(-1).plugins.length, 0);
    await app.plugins.change(next.pluginId, {
      scope: "project",
      workspaceId: session.workspaceId,
      requestId: crypto.randomUUID(),
      expectedRevision: next.revision + 1,
      action: "uninstall",
    });
    assert.equal(app.plugins.skillSources(session.workspaceId).length, 0);
    evidence.ok = true;
  } catch (e) {
    evidence.error =
      e?.code === "ERR_ASSERTION" ? e.message : (e?.code ?? "failed");
  } finally {
    evidence.requests = requests;
    if (app) {
      await app.server.close();
      app.plugins.files.collect(new Set());
    }
    rmSync(root, { recursive: true, force: true });
    report.protocols.push(evidence);
    console.log(JSON.stringify(evidence));
  }
}
report.originalSettingsUnchanged = original() === before;
mkdirSync(".cache/acceptance", { recursive: true });
writeFileSync(
  ".cache/acceptance/plugins-live.json",
  JSON.stringify(report, null, 2),
);
assert(report.originalSettingsUnchanged);
if (report.protocols.some((p) => !p.ok)) process.exitCode = 1;
