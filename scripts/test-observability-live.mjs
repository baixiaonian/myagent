/**
 * 可观测性双协议真实验收：只读已有授权连接，在独立目录验证成员、工具、摘要与原始材料。
 * 真实密钥只经服务端凭证服务进入内存；报告仅写计数、usage、哈希和状态，退出删除原始材料。
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
assert(secret && config.model, "缺少有效授权连接；真实验收未完成。");
const transportOnly = process.env.MYAGENT_TEST_TRANSPORT_ONLY === "1";
const report = {
  date: new Date().toISOString(),
  protocols: [],
  originalSettingsUnchanged: false,
};
for (const protocol of process.env.MYAGENT_TEST_PROTOCOL
  ? [process.env.MYAGENT_TEST_PROTOCOL]
  : ["responses", "chat_completions"]) {
  const root = mkdtempSync(join(tmpdir(), "myagent-observation-live-"));
  let app,
    requests = 0;
  const evidence = {
    protocol,
    ok: false,
    requests: 0,
    members: 0,
    summaries: 0,
    tools: 0,
    traces: 0,
    usage: null,
    captures: [],
    error: null,
    pauses: [],
    approvals: 0,
  };
  console.info(`START ${protocol}`);
  try {
    app = await buildServer({
      dataDir: join(root, "data"),
      workspaceRoot: join(root, "work"),
      serveWeb: false,
      contextTriggerRatio: 0.12,
      modelFactory(_settings, _placeholder, observer) {
        const model =
          protocol === "responses"
            ? new OpenAIResponsesModel(
                config.baseUrl,
                secret,
                config.model,
                observer,
              )
            : new OpenAIChatModel(
                config.baseUrl,
                secret,
                config.model,
                observer,
              );
        return {
          estimateInput: model.estimateInput.bind(model),
          stream(...args) {
            if (requests >= 24)
              throw new AppError("acceptance_limit", "验收费用保护上限");
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
      apiKey: "live-in-memory-placeholder",
      systemPrompt: "",
      contextWindowTokens: 200000,
      outputReserveTokens: 4096,
      expectedRevision: 0,
    });
    app.observations.configure({
      requestId: randomUUID(),
      expectedRevision: 0,
      debug: true,
      retentionDays: 30,
    });
    const session = await app.projects.create({ requestId: randomUUID() });
    async function run(content) {
      const accepted = app.chat.start(session.id, {
        requestId: randomUUID(),
        expectedRevision: app.store.snapshot(session.id).session.revision,
        content,
      });
      const deadline = Date.now() + 620000;
      while (Date.now() < deadline) {
        const r = app.store.getRun(accepted.run.id);
        if (!isActiveRun(r.status)) {
          assert.equal(r.status, "succeeded", r.error?.code ?? "run_failed");
          return r;
        }
        for (const approval of app.store.execution
          .list("approvals")
          .filter((a) => a.status === "pending")) {
          // 验收只批准当前临时项目内的调用；不授予网络、项目外文件或长期命令许可。
          if (
            approval.resources.some(
              (resource) =>
                resource.kind !== "path" ||
                !resource.target.startsWith(join(root, "work")),
            )
          )
            throw new AppError(
              "acceptance_resource_boundary",
              "验收请求了临时项目以外资源",
            );
          const response = await app.server.inject({
            method: "POST",
            url: `/api/v1/approvals/${approval.id}/decision`,
            payload: {
              requestId: randomUUID(),
              decision: "allow",
              scope: "once",
            },
          });
          assert.equal(response.statusCode, 200);
          evidence.approvals++;
        }
        if (
          ["waiting_context", "waiting_reconciliation", "recoverable"].includes(
            r.status,
          )
        ) {
          evidence.pauses.push({
            status: r.status,
            error: app.contexts.view(session.id)?.error?.code ?? null,
          });
          throw new AppError(`acceptance_${r.status}`, r.status);
        }
        await delay(250);
      }
      throw new AppError("acceptance_timeout", "验收超时");
    }
    let calls;
    if (transportOnly) {
      await run("请只回复：流式采集验收完成。不要调用工具。");
      calls = app.observations.calls();
      assert.equal(requests, 1);
    } else {
      const marker = `灯塔-${randomUUID().slice(0, 8)}`;
      const work = app.toolSystem.workspace(session.id).path;
      writeFileSync(
        join(work, "expenses-a.txt"),
        "A组费用：120 + 80 = 200 元。\n",
      );
      writeFileSync(
        join(work, "expenses-b.txt"),
        "B组费用：50 + 70 = 120 元。\n",
      );
      await run(
        `请找一位成员独立核对项目目录中的 expenses-b.txt，你自己核对 expenses-a.txt，汇总两组费用之和并交付简短结论。成员只需核对指定文件，不必扩展任务。项目代号是 ${marker}。以下是已确认背景，不用反复核验：${"项目仅做一次费用核对，无需联网，无需写文件；".repeat(220)}`,
      );
      await run(
        "请查阅之前保存的对话原文，逐字核对项目代号并告诉我费用总额，不再重复核对文件。",
      );
      calls = app.observations.calls();
      const team = app.teams.view(session.id),
        summaries = app.store.context
          .list("summaries", session.id)
          .filter((s) => s.published);
      assert.equal(
        calls.filter((c) => c.sent).length,
        requests,
        "实际请求与独立账本计数不一致",
      );
      assert(team.members.length > 0, "未实际创建成员");
      assert(
        calls.some((c) => c.scope.agentId && c.scope.agentId !== "main"),
        "缺少成员请求关联",
      );
      assert(
        calls.some((c) => c.scope.purpose === "summary"),
        "缺少摘要模型调用",
      );
      assert(summaries.length > 0, "没有生效摘要");
      const tools = app.store.execution.list("invocations", {
        sessionId: session.id,
      });
      assert(
        tools.some((t) => t.result?.ok),
        "缺少工具调用",
      );

      evidence.members = team.members.length;
      evidence.summaries = summaries.length;
      evidence.tools = tools.length;
    }
    // 等待异步文件队列结束；超时保留缺损结论，不能假装采集完整。
    const until = Date.now() + 5000;
    while (
      Date.now() < until &&
      app.observations.store
        .list("captures")
        .some((c) => c.status === "capturing")
    )
      await delay(50);
    for (const call of calls)
      for (const capture of app.observations.call(call.id).captures) {
        const bytes = await app.observations.raw(call.id, capture.id);
        assert.equal(bytes.length, capture.bytes);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          capture.sha256,
        );
        if (capture.direction === "input") {
          assert.equal(capture.status, "complete");
          assert.equal(
            JSON.parse(Buffer.from(bytes).toString()).model,
            config.model,
          );
        }
        if (transportOnly)
          assert.equal(capture.status, "complete", capture.reason ?? "partial");
        evidence.captures.push({
          direction: capture.direction,
          status: capture.status,
          reason: capture.reason,
          bytes: capture.bytes,
          sha256: capture.sha256,
        });
      }
    assert.equal(evidence.captures.length, requests * 2);
    evidence.traces = app.observations.traces().items.length;
    evidence.usage = app.observations.usage().total;
    evidence.ok = true;
    console.info(
      `PASS ${protocol}: ${requests} requests, ${evidence.members} members, ${evidence.summaries} summaries`,
    );
  } catch (error) {
    evidence.error =
      error instanceof AppError
        ? error.code
        : error instanceof assert.AssertionError
          ? error.message.split("\n")[0]
          : "live_failed";
    process.exitCode = 1;
    console.info(`FAIL ${protocol}: ${evidence.error}`);
  } finally {
    evidence.requests = requests;
    report.protocols.push(evidence);
    await app?.server.close();
    rmSync(root, { recursive: true, force: true });
  }
}
report.originalSettingsUnchanged = original() === before;
assert(report.originalSettingsUnchanged);
mkdirSync(".cache/acceptance", { recursive: true });
writeFileSync(
  transportOnly
    ? ".cache/acceptance/observability-transport-live.json"
    : ".cache/acceptance/observability-live.json",
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
