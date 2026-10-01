/**
 * 长期记忆真实验收：只读已有连接，在临时实例验证双协议跨会话提炼、检索、更正和遗忘。
 * 密钥仅由凭证服务读取到内存，报告只含状态/计数；原配置、历史与记忆库均不修改。
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

const require = createRequire(
  new URL("../packages/adapters/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
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
  config = JSON.parse(before);
const secret = new FileCredentialStore(source).read(config.credentialRef);
assert(secret && config.model, "有效模型配置缺失，真实联通尚未验收。");
const report = {
  date: new Date().toISOString(),
  protocols: [],
  originalSettingsUnchanged: false,
};
for (const protocol of ["chat_completions", "responses"]) {
  const dir = mkdtempSync(join(tmpdir(), "myagent-memory-live-"));
  let app;
  let calls = 0;
  const result = {
    protocol,
    ok: false,
    requests: 0,
    backgroundRequests: 0,
    searches: 0,
    reads: 0,
    updates: 0,
  };
  console.info(`START ${protocol}`);
  try {
    app = await buildServer({
      dataDir: join(dir, "data"),
      workspaceRoot: join(dir, "workspaces"),
      serveWeb: false,
      modelFactory() {
        const model =
          protocol === "responses"
            ? new OpenAIResponsesModel(config.baseUrl, secret, config.model)
            : new OpenAIChatModel(config.baseUrl, secret, config.model);
        return {
          estimateInput: (...args) => model.estimateInput(...args),
          stream(...args) {
            if (calls >= 28)
              throw new AppError("acceptance_limit", "本次验收调用超过预算。");
            calls++;
            return model.stream(...args);
          },
        };
      },
    });
    app.settings.save({
      baseUrl: config.baseUrl,
      model: config.model,
      apiProtocol: protocol,
      apiKey: "in-memory-fixture",
      systemPrompt: "用中文简洁回答。",
      contextWindowTokens: config.contextWindowTokens ?? 200000,
      outputReserveTokens: config.outputReserveTokens ?? 4096,
      expectedRevision: 0,
    });
    const settings = app.memories.settings();
    app.memories.saveSettings({
      ...settings,
      enabled: true,
      generateMemories: false,
      expectedRevision: settings.revision,
    });
    const create = () =>
      app.projects.create({ requestId: crypto.randomUUID() });
    async function run(session, content) {
      const accepted = app.chat.start(session.id, {
        requestId: crypto.randomUUID(),
        expectedRevision: app.store.snapshot(session.id).session.revision,
        content,
      });
      for (let i = 0; i < 1800; i++) {
        const end = app.store.getRun(accepted.run.id);
        if (!isActiveRun(end.status)) {
          assert.equal(
            end.status,
            "succeeded",
            end.error?.code ?? "run_failed",
          );
          return (
            app.store
              .snapshot(session.id)
              .messages.find((m) => m.id === end.assistantMessageId)?.content ??
            ""
          );
        }
        if (end.status.startsWith("waiting_")) throw Error(end.status);
        await delay(200);
      }
      throw Error("run_timeout");
    }
    const marker = `星舟-${crypto.randomUUID().slice(0, 6)}`;
    const first = await create();
    await run(
      first,
      `说明一个持续使用的个人工作约定：我的验收日志归档目录代号是「${marker}」，它是已经核实的名称。这里只需确认你理解，不用主动保存或操作任何文件。`,
    );
    const job = await app.memories.jobs.create(first.id, crypto.randomUUID());
    for (let i = 0; i < 1500; i++) {
      app.memories.jobs.kick();
      const j = app.store.memory.get("jobs", job.id);
      if (!["queued", "running", "yielded"].includes(j.status)) break;
      await delay(200);
    }
    const done = app.store.memory.get("jobs", job.id);
    assert.equal(done.status, "completed", done.error?.code ?? "job_failed");
    result.backgroundRequests = done.requests;
    assert(done.requests >= 2, "未完成两阶段模型整理");
    assert(
      (await app.memories.search({ query: marker })).entries.length > 0,
      "没有提炼约定",
    );
    const second = await create();
    const recalled = await run(
      second,
      "请查阅跨会话记忆里保存的验收日志归档约定，并核对它所引用的原始出处。告诉我准确目录代号，不要猜测，也不要读取磁盘文件。",
    );
    assert(recalled.includes(marker), "未准确召回另一会话的约定");
    const next = `新舟-${crypto.randomUUID().slice(0, 6)}`;
    await run(
      second,
      `请更正那条长期记忆：验收日志归档目录改为「${next}」，旧代号已经停用。实际保存更正，其他记忆不用改。`,
    );
    assert(
      (await app.memories.search({ query: next })).entries.length > 0,
      "更正没有保存",
    );
    await run(
      second,
      "请忘记刚才那条验收日志归档目录的长期记忆，删除它，其他记忆不要改。",
    );
    assert.equal(
      (await app.memories.search({ query: next })).entries.length,
      0,
      "遗忘后仍能检索正文",
    );
    const third = await create();
    const snippets = await app.memories.read(
      { sessionId: third.id, workspaceId: null, query: "", budget: 2500 },
      new AbortController().signal,
    );
    assert(!JSON.stringify(snippets).includes(next), "新会话仍注入旧记忆");
    const invocations = app.store.execution
      .list("invocations", { sessionId: second.id })
      .filter((i) => i.result?.ok);
    result.searches = invocations.filter(
      (i) => i.toolName === "search_memories",
    ).length;
    result.reads = invocations.filter(
      (i) => i.toolName === "read_memory",
    ).length;
    result.updates = invocations.filter(
      (i) => i.toolName === "update_memory",
    ).length;
    assert(
      result.reads > 0 && result.updates >= 2,
      "模型没有实际查阅及更正/遗忘工具闭环",
    );
    result.ok = true;
  } catch (error) {
    result.error =
      error instanceof AppError
        ? error.code
        : error instanceof assert.AssertionError
          ? error.message
          : "live_request_failed";
  } finally {
    result.requests = calls;
    report.protocols.push(result);
    await app?.server.close();
    rmSync(dir, { recursive: true, force: true });
    console.info(JSON.stringify(result));
  }
}
report.originalSettingsUnchanged = before === original();
mkdirSync(".cache/acceptance", { recursive: true });
writeFileSync(
  ".cache/acceptance/memory-live.json",
  JSON.stringify(report, null, 2),
);
assert(report.originalSettingsUnchanged, "原模型配置发生变化");
assert(
  report.protocols.every((r) => r.ok),
  "至少一种协议未通过，详见脱敏验收报告。",
);
