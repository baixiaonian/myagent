/** Hook 双协议真实验收：只读既有凭证，在临时实例验证真实模型调整工具操作；原设置与历史不修改。 */
import assert from "node:assert/strict";
import {
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
  LocalHookFiles,
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
for (const protocol of ["responses", "chat_completions"]) {
  const root = mkdtempSync(join(tmpdir(), "myagent-hook-live-")),
    data = join(root, "data"),
    work = join(root, "project"),
    pkg = join(root, "hooks");
  mkdirSync(work);
  mkdirSync(pkg);
  writeFileSync(join(work, "README.md"), "这是自然语言任务的隔离验收项目。\n");
  writeFileSync(
    join(pkg, "main.mjs"),
    `/** 真实验收 Hook，仅修改已授权测试文件。 */\nimport fs from 'node:fs';const e=JSON.parse(fs.readFileSync(0,'utf8'));let out={decision:'continue'};if(e.event==='RunStart')out.additionalContext='项目报告应包含标记 HOOK_LIVE_73。遵守工具返回的目录约束。';if(e.event==='PreToolUse'&&!String(e.tool.arguments.path??'').includes('reports/'))out={decision:'deny',reason:'报告必须保存为 reports/final.txt，请使用这个路径重新执行。'};if(e.event==='PostToolUse'){fs.appendFileSync('reports/final.txt','\\nHOOK_FORMATTED\\n');out.additionalContext='报告已经格式化，建议读取 reports/final.txt 查看当前真实内容。';}if(e.event==='RunEnd')fs.appendFileSync('audit.txt',e.outcome.status+'\\n');console.log(JSON.stringify(out));`,
  );
  let app,
    requests = 0;
  const result = {
    protocol,
    ok: false,
    requests: 0,
    events: [],
    stepCount: 0,
    failureEnd: false,
    error: null,
  };
  try {
    app = await buildServer({
      dataDir: data,
      workspaceRoot: join(root, "workspaces"),
      skillRoot: join(root, "skills"),
      serveWeb: false,
      modelFactory(settings) {
        const m =
          protocol === "responses"
            ? new OpenAIResponsesModel(config.baseUrl, secret, settings.model)
            : new OpenAIChatModel(config.baseUrl, secret, settings.model);
        return {
          estimateInput: m.estimateInput?.bind(m),
          async *stream(...args) {
            requests++;
            yield* m.stream(...args);
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
      contextWindowTokens: 200000,
      outputReserveTokens: 4096,
      expectedRevision: 0,
    });
    const initial = app.hooks.view({ scope: "user" }),
      hooks = ["RunStart", "PreToolUse", "PostToolUse", "RunEnd"].map(
        (event) => ({
          id: event,
          event,
          enabled: true,
          packagePath: pkg,
          entry: "main.mjs",
          interpreter: "node",
          args: [],
          timeoutMs: 30000,
          ...(event.includes("Tool") ? { tools: ["write_file"] } : {}),
          permissions: {
            writePaths:
              event === "PostToolUse"
                ? ["reports"]
                : event === "RunEnd"
                  ? ["audit.txt"]
                  : [],
            networkDomains: [],
          },
        }),
      ),
      text = JSON.stringify({ schemaVersion: 1, hooks });
    const preview = await app.hooks.save({
      scope: "user",
      text,
      expectedRevision: initial.revision,
    });
    assert(!preview.error, preview.error);
    await app.hooks.save({
      scope: "user",
      text,
      expectedRevision: initial.revision,
      expectedVersion: preview.version,
    });
    const session = await app.projects.create({
      requestId: crypto.randomUUID(),
      path: work,
    });
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
        if (!["queued", "running", "cleaning"].includes(current.status))
          return current;
        await delay(150);
      }
      await app.chat.cancel(r.id);
      throw new Error("live_deadline");
    }
    const run = await task(
      "请在 report.txt 写一段简短的项目说明，包含项目约定的标记。工具若反馈路径约束请按约束调整，完成后读回确认内容。无需运行命令或联网。",
    );
    assert.equal(run.status, "succeeded");
    const events = app.hooks.records(session.id);
    assert(
      events.some((e) => e.event === "PreToolUse" && e.status === "denied"),
    );
    assert(
      events.some((e) => e.event === "PostToolUse" && e.status === "succeeded"),
    );
    assert(
      events.some((e) => e.event === "RunEnd" && e.status === "succeeded"),
    );
    const body = readFileSync(join(work, "reports/final.txt"), "utf8");
    assert(body.includes("HOOK_FORMATTED"));
    assert(body.includes("HOOK_LIVE_73"));
    assert(readFileSync(join(work, "audit.txt"), "utf8").includes("succeeded"));
    // 使用同一真实服务的不存在模型返回已知错误，验证失败收尾；不修改用户设置。
    const current = app.settings.get();
    app.settings.save({
      baseUrl: config.baseUrl,
      model: "myagent-hook-missing-model-acceptance",
      apiProtocol: protocol,
      systemPrompt: "",
      expectedRevision: current.revision,
    });
    const failure = await task("你好");
    assert.equal(failure.status, "failed");
    assert(readFileSync(join(work, "audit.txt"), "utf8").includes("failed"));
    result.failureEnd = true;
    result.events = events.map((e) => ({ event: e.event, status: e.status }));
    result.stepCount = run.stepCount;
    result.ok = true;
  } catch (error) {
    result.error = {
      code: typeof error?.code === "string" ? error.code : "acceptance_failed",
      message: secret
        ? String(error?.message ?? error)
            .split(secret)
            .join("[REDACTED]")
        : "缺少配置",
    };
  } finally {
    result.requests = requests;
    if (app) {
      const files = new LocalHookFiles(data, app.store.execution);
      await app.server.close();
      files.packages.collect(new Set());
    }
    rmSync(root, { recursive: true, force: true });
    report.protocols.push(result);
    console.info(JSON.stringify(result));
  }
}
report.originalSettingsUnchanged = original() === before;
mkdirSync(".cache/acceptance", { recursive: true });
writeFileSync(
  ".cache/acceptance/hooks-live.json",
  JSON.stringify(report, null, 2),
);
assert(report.originalSettingsUnchanged);
if (report.protocols.some((p) => !p.ok)) process.exitCode = 1;
