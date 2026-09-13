/**
 * 已授权的双协议真实 Agent 验收：只读原配置，通过既有凭证适配器在内存中使用密钥。
 * 为每种协议创建独立临时服务，持久化的测试配置只含占位密钥；绝不修改用户配置或原会话。
 * 报告只保存协议、状态、步骤和工具统计；无密钥、续接字段或完整会话，测试目录最终清理。
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

const source = resolve(
  process.env.MYAGENT_SOURCE_DATA_DIR ?? join(homedir(), ".myagent"),
);
const require = createRequire(
  new URL("../packages/adapters/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
// readonly 模式不会迁移原数据库，也不会运行遗留 Run 恢复。
const original = new Database(join(source, "state.db"), {
  readonly: true,
  fileMustExist: true,
});
const before = original
  .prepare("SELECT data FROM settings WHERE id=1")
  .get().data;
const config = JSON.parse(before);
original.close();
const credentials = new FileCredentialStore(source);
const secret = credentials.read(config.credentialRef);
assert(secret && config.model, "没有可用的已配置模型");
const report = {
  date: new Date().toISOString(),
  model: config.model,
  protocols: [],
};
for (const protocol of ["chat_completions", "responses"]) {
  const dir = mkdtempSync(join(tmpdir(), "myagent-live-agent-"));
  let app;
  let requests = 0;
  const result = { protocol, ok: false, checks: [] };
  try {
    app = await buildServer({
      dataDir: dir,
      serveWeb: false,
      modelFactory() {
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
      apiKey: "live-memory-only-reference",
      systemPrompt: config.systemPrompt,
      expectedRevision: 0,
    });
    const address = await app.server.listen({ host: "127.0.0.1", port: 0 });
    async function api(path, method = "GET", data) {
      const r = await fetch(`${address}/api/v1${path}`, {
        method,
        ...(data
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            }
          : {}),
      });
      assert(r.ok, `HTTP ${r.status}`);
      return r.json();
    }
    async function waitRun(sessionId, runId) {
      const deadline = Date.now() + 620000;
      while (Date.now() < deadline) {
        const snapshot = await api(`/sessions/${sessionId}`);
        if (
          snapshot.latestRun?.id === runId &&
          snapshot.latestRun.status !== "running"
        )
          return snapshot;
        await delay(300);
      }
      throw new Error("live_deadline");
    }
    const session = await api("/sessions", "POST", {});
    const accepted = await api(`/sessions/${session.id}/runs`, "POST", {
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      content:
        "进行一次真实工具验收：请使用 update_plan 创建包含“查询时间”和“回复”两项的计划，调用 get_current_time 查询 Pacific/Auckland 当前时间，然后调用 update_plan 更新已完成状态。最后用一句中文给出查询到的当地时间。请实际调用工具，不要只描述计划，不需要我确认。",
    });
    const snapshot = await waitRun(session.id, accepted.run.id);
    assert.equal(
      snapshot.latestRun.status,
      "succeeded",
      snapshot.latestRun.error?.code,
    );
    const calls = snapshot.steps.flatMap((s) => s.tools);
    assert(
      calls.some((t) => t.name === "get_current_time" && t.result?.ok),
      "未实际获取时间",
    );
    assert(
      calls.filter((t) => t.name === "update_plan" && t.result?.ok).length >= 2,
      "未创建及更新计划",
    );
    assert(snapshot.steps.length >= 2, "没有多次模型交互");
    assert(!JSON.stringify(snapshot).includes(secret), "公开结果泄漏凭证");
    result.steps = snapshot.steps.length;
    result.tools = calls.map((t) => ({ name: t.name, status: t.status }));
    result.checks.push("真实工具调用、计划更新、多次模型请求、公开数据边界");
    const follow = await api(`/sessions/${session.id}/runs`, "POST", {
      requestId: crypto.randomUUID(),
      expectedRevision: snapshot.session.revision,
      content:
        "上一轮 get_current_time 使用的 IANA 时区名称是什么？只回答该名称，不需要再次查询时间。",
    });
    const followSnapshot = await waitRun(session.id, follow.run.id);
    assert.equal(
      followSnapshot.latestRun.status,
      "succeeded",
      followSnapshot.latestRun.error?.code,
    );
    assert(
      followSnapshot.messages.at(-1).content.includes("Pacific/Auckland"),
      "工具上下文未在后续问题中保留",
    );
    result.checks.push("真实后续追问及续接材料重放");
    result.ok = true;
    console.info(
      `PASS ${protocol}: ${snapshot.steps.length} steps, ${calls.length} tools`,
    );
  } catch (error) {
    // 只记录应用错误码或本脚本断言；不打印 SDK 对象、请求或模型正文。
    result.error =
      error?.code ??
      (error instanceof assert.AssertionError
        ? error.message.split("\n")[0]
        : "live_failed");
    console.error(`FAIL ${protocol}: ${result.error}`);
    process.exitCode = 1;
  } finally {
    result.requests = requests;
    report.protocols.push(result);
    await app?.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const verify = new Database(join(source, "state.db"), {
  readonly: true,
  fileMustExist: true,
});
assert.equal(
  verify.prepare("SELECT data FROM settings WHERE id=1").get().data,
  before,
  "用户配置发生变化",
);
verify.close();
report.originalSettingsUnchanged = true;
mkdirSync(".cache/acceptance", { recursive: true });
writeFileSync(
  ".cache/acceptance/agent-live.json",
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
