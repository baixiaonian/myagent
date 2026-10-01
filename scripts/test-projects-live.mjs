/**
 * 已授权的真实项目验收：当前模型分别在默认目录和指定目录执行自然语言文件/命令任务。
 * 原配置只读，密钥经既有服务端凭证适配器留在内存，不进入临时目录、参数或报告。
 */
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
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildServer } from "../apps/server/dist/bootstrap/index.js";
import {
  FileCredentialStore,
  OpenAIChatModel,
  OpenAIResponsesModel,
} from "../packages/adapters/dist/index.js";
import { isActiveRun } from "../packages/contracts/dist/index.js";

const require = createRequire(
  new URL("../packages/adapters/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const source =
  process.env.MYAGENT_SOURCE_DATA_DIR ?? join(homedir(), ".myagent");
const db = new Database(join(source, "state.db"), {
  readonly: true,
  fileMustExist: true,
});
const before = db.prepare("SELECT data FROM settings WHERE id=1").get()?.data;
db.close();
assert(before, "没有模型配置");
const config = JSON.parse(before);
const secret = new FileCredentialStore(source).read(config.credentialRef);
assert(secret, "没有可用密钥");
const report = {
  date: new Date().toISOString(),
  model: config.model,
  protocol: config.apiProtocol ?? "chat_completions",
  tasks: [],
};
for (const mode of ["default", "selected"]) {
  const root = mkdtempSync(join(tmpdir(), "myagent-project-live-"));
  let app;
  let requests = 0;
  const result = { mode, ok: false };
  try {
    const explicit = join(root, "selected");
    mkdirSync(explicit);
    app = await buildServer({
      dataDir: join(root, "data"),
      workspaceRoot: join(root, "workspaces"),
      serveWeb: false,
      modelFactory: () => {
        const model =
          report.protocol === "responses"
            ? new OpenAIResponsesModel(config.baseUrl, secret, config.model)
            : new OpenAIChatModel(config.baseUrl, secret, config.model);
        return {
          stream(...args) {
            requests++;
            return model.stream(...args);
          },
        };
      },
    });
    app.settings.save({
      apiProtocol: report.protocol,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: "memory-only-project-fixture",
      systemPrompt: config.systemPrompt,
      expectedRevision: 0,
    });
    const created = await app.server.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: {
        requestId: crypto.randomUUID(),
        ...(mode === "selected" ? { path: explicit } : {}),
      },
    });
    assert.equal(created.statusCode, 201);
    const session = created.json();
    const workspace = app.store.execution.get(
      "workspaces",
      session.workspaceId,
    );
    assert(workspace);
    assert.equal(workspace.kind, mode === "default" ? "default" : "project");
    const response = await app.server.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/runs`,
      payload: {
        requestId: crypto.randomUUID(),
        expectedRevision: session.revision,
        content:
          "请在当前工作目录新建 notes.txt，第一行写‘项目任务验收’，第二行写‘本次只处理当前目录’。然后运行一个本地命令确认文件内容，最后告诉我实际完成了什么。不要访问网络或其他目录。",
      },
    });
    assert.equal(response.statusCode, 202);
    const runId = response.json().run.id;
    const deadline = Date.now() + 620000;
    while (Date.now() < deadline) {
      const run = app.store.getRun(runId);
      if (!isActiveRun(run.status)) break;
      assert(
        !["waiting_approval", "waiting_reconciliation", "recoverable"].includes(
          run.status,
        ),
        run.status,
      );
      await delay(300);
    }
    const snapshot = app.store.snapshot(session.id);
    assert.equal(
      snapshot.latestRun.status,
      "succeeded",
      snapshot.latestRun.error?.code,
    );
    const tools = snapshot.steps.flatMap((s) => s.tools);
    assert(
      tools.some((t) => t.name === "write_file" || t.name === "exec_command"),
    );
    assert(tools.some((t) => t.name === "exec_command"));
    const content = readFileSync(join(workspace.path, "notes.txt"), "utf8");
    assert(
      content.includes("项目任务验收") &&
        content.includes("本次只处理当前目录"),
    );
    result.ok = true;
    result.steps = snapshot.steps.length;
    result.tools = tools.map((t) => t.name);
    result.fileVerified = true;
    console.info(
      `PASS ${mode}: ${result.steps} steps, ${requests} model requests`,
    );
  } catch (error) {
    result.error =
      error?.code ??
      (error instanceof assert.AssertionError
        ? error.message.split("\n")[0]
        : "live_failed");
    console.error(`FAIL ${mode}: ${result.error}`);
    process.exitCode = 1;
  } finally {
    result.requests = requests;
    report.tasks.push(result);
    await app?.server.close();
    rmSync(root, { recursive: true, force: true });
  }
}
const verify = new Database(join(source, "state.db"), {
  readonly: true,
  fileMustExist: true,
});
assert.equal(
  verify.prepare("SELECT data FROM settings WHERE id=1").get().data,
  before,
);
verify.close();
report.originalSettingsUnchanged = true;
mkdirSync(".cache/acceptance", { recursive: true });
writeFileSync(
  ".cache/acceptance/projects-live.json",
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
