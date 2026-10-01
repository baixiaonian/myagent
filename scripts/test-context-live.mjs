/**
 * 已授权上下文真实验收：只读原配置，凭证仅经既有服务在内存使用。
 * 双协议各建临时实例，以较低压缩阈值验证自然语言任务、摘要与历史查阅；不改变用户设置。
 * 报告只保存状态与计数，禁止输出模型请求、续接、凭证或用户历史。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { AppError, isActiveRun } from "../packages/contracts/dist/index.js";

const source = resolve(
  process.env.MYAGENT_SOURCE_DATA_DIR ?? join(homedir(), ".myagent"),
);
const require = createRequire(
  new URL("../packages/adapters/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const db = new Database(join(source, "state.db"), {
  readonly: true,
  fileMustExist: true,
});
const before = db.prepare("SELECT data FROM settings WHERE id=1").get().data;
db.close();
const config = JSON.parse(before);
const secret = new FileCredentialStore(source).read(config.credentialRef);
assert(secret && config.model, "未提供有效模型配置，真实联通尚未验收。");
const report = {
  date: new Date().toISOString(),
  protocols: [],
  originalSettingsUnchanged: false,
};
for (const protocol of ["chat_completions", "responses"]) {
  const dir = mkdtempSync(join(tmpdir(), "myagent-context-live-"));
  let app;
  let calls = 0;
  const result = {
    protocol,
    ok: false,
    modelRequests: 0,
    summaries: 0,
    historyReads: 0,
  };
  console.info(`START ${protocol}`);
  try {
    app = await buildServer({
      dataDir: join(dir, "data"),
      workspaceRoot: join(dir, "workspaces"),
      serveWeb: false,
      contextTriggerRatio: 0.12,
      modelFactory() {
        const model =
          protocol === "responses"
            ? new OpenAIResponsesModel(config.baseUrl, secret, config.model)
            : new OpenAIChatModel(config.baseUrl, secret, config.model);
        return {
          estimateInput: (...args) => model.estimateInput(...args),
          stream(...args) {
            // 这是验收脚本的费用保险，不是产品 Loop 的固定轮数限制。
            if (calls >= 24)
              throw new AppError(
                "acceptance_limit",
                "验收请求数量超过预期，停止以排查。",
              );
            calls++;
            return model.stream(...args);
          },
        };
      },
    });
    app.settings.save({
      apiProtocol: protocol,
      baseUrl: config.baseUrl,
      model: config.model,
      systemPrompt: config.systemPrompt,
      apiKey: "live-in-memory-placeholder",
      // 独立验收沿用显式容量；未配置时使用测试小窗口，避免为触发摘要扩大付费输入。
      contextWindowTokens: config.contextWindowTokens ?? 32768,
      outputReserveTokens: config.outputReserveTokens ?? 4096,
      expectedRevision: 0,
    });
    const session = await app.projects.create({
      requestId: crypto.randomUUID(),
    });
    async function run(content) {
      const accepted = app.chat.start(session.id, {
        requestId: crypto.randomUUID(),
        expectedRevision: app.store.snapshot(session.id).session.revision,
        content,
      });
      const end = Date.now() + 620000;
      while (Date.now() < end) {
        const value = app.store.getRun(accepted.run.id);
        if (!isActiveRun(value.status)) {
          assert.equal(
            value.status,
            "succeeded",
            value.error?.code ?? "run_failed",
          );
          return value;
        }
        if (
          [
            "waiting_context",
            "waiting_approval",
            "waiting_reconciliation",
          ].includes(value.status)
        )
          throw new Error(value.status);
        await delay(300);
      }
      throw new Error("live_deadline");
    }
    const marker = `航标-${crypto.randomUUID().slice(0, 8)}`;
    await run(
      `项目代号是「${marker}」，请记住。我在上海，同事在纽约，现在两边分别几点？现在适合安排电话会议吗？请根据实际时间判断。附录是历史背景，不必复述：${"已完成准备，等待时间核对；".repeat(400)}`,
    );
    const follow = await run(
      "请核对这段对话保存的原文，逐字告诉我之前给出的项目代号，不要只凭摘要猜测。",
    );
    const snapshot = app.store.snapshot(session.id);
    assert(
      snapshot.messages
        .find((m) => m.id === follow.assistantMessageId)
        ?.content.includes(marker),
      "历史细节核对未通过",
    );
    const invocations = app.store.execution.list("invocations", {
      sessionId: session.id,
    });
    result.historyReads = invocations.filter(
      (i) => i.toolName === "read_conversation_history" && i.result?.ok,
    ).length;
    assert(result.historyReads > 0, "模型未实际查阅历史原文");
    result.summaries = app.store.context
      .list("summaries", session.id)
      .filter((s) => s.published).length;
    assert(result.summaries > 0, "没有触发已发布摘要");
    assert(
      invocations.some(
        (i) => i.toolName === "get_current_time" && i.result?.ok,
      ),
      "未实际查询时间",
    );
    assert(
      !JSON.stringify(app.contexts.view(session.id)).includes(secret),
      "公开视图泄漏凭证",
    );
    result.ok = true;
    console.info(
      `PASS ${protocol}: summaries=${result.summaries}, historyReads=${result.historyReads}`,
    );
  } catch (error) {
    result.error =
      error?.code ??
      (error instanceof assert.AssertionError
        ? error.message.split("\n")[0]
        : [
              "waiting_context",
              "waiting_approval",
              "waiting_reconciliation",
              "live_deadline",
            ].includes(error?.message)
          ? error.message
          : "live_failed");
    console.info(`FAIL ${protocol}: ${result.error}`);
    process.exitCode = 1;
  } finally {
    result.modelRequests = calls;
    report.protocols.push(result);
    await app?.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const check = new Database(join(source, "state.db"), {
  readonly: true,
  fileMustExist: true,
});
assert.equal(
  check.prepare("SELECT data FROM settings WHERE id=1").get().data,
  before,
  "原配置发生变化",
);
check.close();
report.originalSettingsUnchanged = true;
mkdirSync(".cache/acceptance", { recursive: true });
writeFileSync(
  ".cache/acceptance/context-live.json",
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
