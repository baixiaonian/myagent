/**
 * 轻量团队双协议真实验收：只读原设置，经凭证服务取密钥到内存，临时实例使用占位凭证。
 * 验收任务与文件都在本脚本创建的目录，报告只保留状态/调用名/计数；不记录私有续接和密钥。
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
assert(secret && config.model, "缺少有效已授权配置；真实模型验收未完成。");
const report = {
  date: new Date().toISOString(),
  protocols: [],
  originalSettingsUnchanged: false,
};
for (const protocol of process.env.MYAGENT_TEST_PROTOCOL
  ? [process.env.MYAGENT_TEST_PROTOCOL]
  : ["responses", "chat_completions"]) {
  const root = mkdtempSync(join(tmpdir(), "myagent-team-live-"));
  let app,
    requests = 0;
  const evidence = {
    protocol,
    ok: false,
    requests: 0,
    runs: [],
    members: 0,
    directMessages: 0,
    mainToolActions: [],
    files: [],
    memberStates: [],
    messageTrace: [],
    error: null,
  };
  try {
    app = await buildServer({
      dataDir: join(root, "data"),
      workspaceRoot: join(root, "work"),
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
      apiProtocol: protocol,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: "local-live-placeholder",
      systemPrompt: "",
      contextWindowTokens: config.contextWindowTokens ?? 200000,
      outputReserveTokens: config.outputReserveTokens ?? 4096,
      expectedRevision: 0,
    });
    const session = await app.projects.create({
      requestId: crypto.randomUUID(),
    });
    const work = app.toolSystem.workspace(session.id).path;
    writeFileSync(join(work, "sales.csv"), "city,amount\n北京,100\n上海,200\n");
    async function run(content) {
      const accepted = app.chat.start(session.id, {
        requestId: crypto.randomUUID(),
        expectedRevision: app.store.snapshot(session.id).session.revision,
        content,
      });
      const until = Date.now() + 600000;
      while (
        isActiveRun(app.store.getRun(accepted.run.id).status) &&
        Date.now() < until
      ) {
        const team = app.teams.view(session.id);
        for (const member of team.members) {
          if (
            [
              "waiting_approval",
              "waiting_context",
              "waiting_reconciliation",
            ].includes(member.runStatus)
          )
            throw new Error(`成员需要人工处理：${member.runStatus}`);
        }
        await delay(200);
      }
      const finished = app.store.getRun(accepted.run.id);
      evidence.runs.push({
        id: finished.id,
        status: finished.status,
        steps: finished.stepCount,
        error: finished.error?.code ?? null,
      });
      assert.equal(
        finished.status,
        "succeeded",
        finished.error?.code ?? "任务未正常结束",
      );
      return finished;
    }
    const first = await run(
      "请安排一位数据分析员和一位复核员协作检查 sales.csv，分析员与复核员直接交流确认总额与字段。分析员写 analysis.md，复核员写 review.md。你也要亲自读取输入数据并写 summary.md，整合他们的结果向我交付。内容简洁，核实总额，不需要运行命令，文件读写即可完成。后续我还会找这两位成员复核，请保留他们供下一轮使用，不关闭成员。",
    );
    const initial = app.teams.view(session.id).members;
    evidence.members = initial.length;
    evidence.memberStates.push(
      initial.map((m) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        runId: m.runId,
      })),
    );
    assert(initial.length >= 2, "没有形成至少两位成员");
    const direct = app.store.teams
      .list("messages")
      .filter(
        (m) =>
          m.sessionId === session.id &&
          m.from !== "main" &&
          m.to !== "main" &&
          m.kind !== "result",
      );
    evidence.directMessages = direct.length;
    evidence.messageTrace = direct.map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      kind: m.kind,
      content: m.content,
      includedRunId: m.includedRunId,
      replyTo: m.replyTo,
    }));
    assert(direct.length > 0, "未观察到成员直接通信");
    evidence.mainToolActions = app.store.execution
      .list("invocations", { runId: first.id })
      .map((i) => i.toolName);
    assert(
      evidence.mainToolActions.includes("read_file") &&
        evidence.mainToolActions.includes("write_file"),
      "主 Agent 没有亲自读写",
    );
    for (const name of ["analysis.md", "review.md", "summary.md"]) {
      const text = readFileSync(join(work, name), "utf8");
      assert(text.includes("300"), `${name} 未记录正确总额`);
      evidence.files.push({ name, verifiedTotal: 300, content: text });
    }
    await run(
      "请继续使用刚才的复核员，再检查 summary.md 是否正确反映总额；沿用已有成员，不要新建。你确认后简短答复即可。",
    );
    const after = app.teams.view(session.id);
    evidence.memberStates.push(
      after.members.map((m) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        runId: m.runId,
      })),
    );
    assert.deepEqual(
      after.members.map((m) => m.id).sort(),
      initial.map((m) => m.id).sort(),
    );
    assert(
      after.members.some(
        (m) => m.runId !== initial.find((i) => i.id === m.id)?.runId,
      ),
      "未复用成员运行",
    );
    evidence.ok = true;
  } catch (error) {
    const detail = String(error?.message ?? "验收失败");
    evidence.error = {
      code: error?.code ?? "acceptance_failed",
      message: detail.includes(secret)
        ? "redacted_error"
        : detail.slice(0, 300),
    };
  } finally {
    evidence.requests = requests;
    if (app) await app.server.close();
    rmSync(root, { recursive: true, force: true });
    report.protocols.push(evidence);
    console.log(
      JSON.stringify({
        protocol,
        ok: evidence.ok,
        requests,
        error: evidence.error,
      }),
    );
  }
}
report.originalSettingsUnchanged = original() === before;
assert(report.originalSettingsUnchanged, "原设置发生变化");
mkdirSync(".cache/acceptance", { recursive: true });
writeFileSync(
  ".cache/acceptance/teams-live.json",
  JSON.stringify(report, null, 2),
);
if (report.protocols.some((p) => !p.ok)) process.exitCode = 1;
