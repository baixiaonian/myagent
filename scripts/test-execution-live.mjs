/**
 * 已授权的真实工具产品验收：在独立临时工作区让当前模型完成自然语言文件任务。
 * 原配置只读，密钥只经服务端凭证适配器进入内存，不进入参数/报告/工作区；最后清理测试资源。
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
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildServer } from "../apps/server/dist/bootstrap/index.js";
import {
  FileCredentialStore,
  OpenAIChatModel,
  OpenAIResponsesModel,
} from "../packages/adapters/dist/index.js";
import { isActiveRun } from "../packages/contracts/dist/index.js";

const source = resolve(
  process.env.MYAGENT_SOURCE_DATA_DIR ?? join(homedir(), ".myagent"),
);
const require = createRequire(
  new URL("../packages/adapters/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const original = new Database(join(source, "state.db"), {
  readonly: true,
  fileMustExist: true,
});
const before = original
  .prepare("SELECT data FROM settings WHERE id=1")
  .get()?.data;
original.close();
assert(before, "缺少已配置模型");
const config = JSON.parse(before);
const secret = new FileCredentialStore(source).read(config.credentialRef);
assert(secret, "缺少已保存密钥");
const report = {
  date: new Date().toISOString(),
  model: config.model,
  protocols: [],
};
for (const protocol of ["responses", "chat_completions"]) {
  const root = mkdtempSync(join(tmpdir(), "myagent-execution-live-"));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, "notes.txt"), "旧标题\n保留这行正文。\n");
  let app;
  let requests = 0;
  const result = { protocol, ok: false };
  try {
    app = await buildServer({
      dataDir: join(root, "data"),
      serveWeb: false,
      modelFactory: () => {
        const model =
          protocol === "responses"
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
      apiProtocol: protocol,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: "memory-only-fixture",
      systemPrompt: config.systemPrompt,
      expectedRevision: 0,
    });
    const workspace = await app.toolSystem.createWorkspace(
      workspacePath,
      "独立真实验收",
    );
    const session = app.store.createSession();
    app.store.execution.bindWorkspace(
      session.id,
      workspace.id,
      session.revision,
    );
    const bound = app.store.snapshot(session.id);
    const accepted = app.chat.start(session.id, {
      requestId: crypto.randomUUID(),
      expectedRevision: bound.session.revision,
      content:
        "请查看工作区里的 notes.txt，把‘旧标题’改成‘新标题’，保留其他内容；运行一个简单的验证命令确认文件内容，然后告诉我实际修改和验证结果。只处理当前工作区，不访问其他目录或网络。",
    });
    async function wait(runId) {
      const deadline = Date.now() + 620000;
      while (Date.now() < deadline) {
        const run = app.store.getRun(runId);
        if (
          [
            "waiting_approval",
            "waiting_reconciliation",
            "recoverable",
          ].includes(run.status)
        )
          throw new Error(run.status);
        if (!isActiveRun(run.status)) return app.store.snapshot(session.id);
        await delay(250);
      }
      throw new Error("live_deadline");
    }
    const snapshot = await wait(accepted.run.id);
    assert.equal(
      snapshot.latestRun.status,
      "succeeded",
      snapshot.latestRun.error?.code,
    );
    assert.equal(
      readFileSync(join(workspacePath, "notes.txt"), "utf8"),
      "新标题\n保留这行正文。\n",
    );
    const tools = snapshot.steps.flatMap((step) => step.tools);
    assert(
      tools.some((tool) => tool.name === "exec_command" && tool.result?.ok),
      "模型未运行验证命令",
    );
    assert(snapshot.steps.length >= 2, "没有工具反馈后的模型请求");
    assert(!JSON.stringify(snapshot).includes(secret), "公开结果包含凭证");
    result.steps = snapshot.steps.length;
    result.tools = tools.map((tool) => ({
      name: tool.name,
      status: tool.status,
    }));
    const follow = app.chat.start(session.id, {
      requestId: crypto.randomUUID(),
      expectedRevision: snapshot.session.revision,
      content: "你刚才修改的文件叫什么？只回答文件名。",
    });
    const reply = await wait(follow.run.id);
    assert.equal(reply.latestRun.status, "succeeded");
    assert(reply.messages.at(-1).content.includes("notes.txt"));
    result.ok = true;
    console.info(
      `PASS ${protocol}: ${result.steps} steps, ${tools.length} tools`,
    );
  } catch (error) {
    result.error =
      error?.code ??
      (error instanceof assert.AssertionError
        ? error.message.split("\n")[0]
        : [
              "waiting_approval",
              "waiting_reconciliation",
              "recoverable",
              "live_deadline",
            ].includes(error?.message)
          ? error.message
          : "live_failed");
    console.error(`FAIL ${protocol}: ${result.error}`);
    process.exitCode = 1;
  } finally {
    result.requests = requests;
    report.protocols.push(result);
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
  ".cache/acceptance/execution-live.json",
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
