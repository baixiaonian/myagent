/**
 * Skill 真实双协议验收：只读现有连接，通过凭证服务在内存复用密钥；临时项目内完成自然任务、压缩及显式选择。
 * 仅批准验收脚本的本次启动，不自动批准额外网络/写入；原模型配置、用户会话和技能文件均不修改。
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
  config = JSON.parse(before),
  secret = new FileCredentialStore(source).read(config.credentialRef);
assert(secret && config.model, "缺少有效连接，真实模型尚未验收。");
const report = {
  date: new Date().toISOString(),
  protocols: [],
  originalSettingsUnchanged: false,
};
const protocols = process.env.MYAGENT_SKILL_LIVE_PROTOCOL
  ? [process.env.MYAGENT_SKILL_LIVE_PROTOCOL]
  : ["responses", "chat_completions"];
assert(protocols.every((p) => ["responses", "chat_completions"].includes(p)));
for (const protocol of protocols) {
  const root = mkdtempSync(join(tmpdir(), "myagent-skill-live-")),
    work = join(root, "project"),
    skillRoot = join(root, "skills"),
    skill = join(work, ".myagent/skills/sales-report");
  mkdirSync(join(work, "data"), { recursive: true });
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(join(skill, "scripts"));
  mkdirSync(skillRoot);
  writeFileSync(
    join(work, "data/sales.csv"),
    "month,amount\n2026-01,12\n2026-02,30\n",
  );
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: sales-report\ndescription: 本项目销售 CSV 的月度汇总与报告规范。生成或校验销售报表时使用。\n---\n请先读取 references/format.md，随后用 exec_command 在项目根目录执行本技能 scripts/report.mjs（使用 node，并以提供的技能运行根目录定位脚本）。脚本已经实现统计，不需要自行重新实现。最后读取生成的 reports/sales.md 核验总额。不得安装依赖或联网。关键规范标识：SALES_SKILL_42。\n",
  );
  writeFileSync(
    join(skill, "references/format.md"),
    "报告路径 reports/sales.md，按月份展示金额及总额。完成后报告总额和输出路径。\n",
  );
  writeFileSync(
    join(skill, "scripts/report.mjs"),
    "/** 隔离验收脚本：读取项目 CSV 并生成报告，不联网。 */\nimport fs from 'node:fs';\nconst rows=fs.readFileSync('data/sales.csv','utf8').trim().split('\\n').slice(1).map(r=>r.split(','));\nconst sum=rows.reduce((n,r)=>n+Number(r[1]),0);fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/sales.md','# 月度销售\\n'+rows.map(r=>r.join(': ')).join('\\n')+'\\n总额：'+sum+'\\n');console.log('报告完成，总额='+sum);\n",
  );
  let app,
    requests = 0,
    summaryRequests = 0;
  const result = {
    protocol,
    ok: false,
    requests: 0,
    summaryRequests: 0,
    approvals: 0,
    tools: [],
    nextRunInherited: false,
    error: null,
    providerDiagnostics: [],
  };
  try {
    app = await buildServer({
      dataDir: join(root, "data"),
      workspaceRoot: join(root, "defaults"),
      skillRoot,
      serveWeb: false,
      contextTriggerRatio: 0.01,
      modelFactory() {
        const model =
          protocol === "responses"
            ? new OpenAIResponsesModel(config.baseUrl, secret, config.model)
            : new OpenAIChatModel(config.baseUrl, secret, config.model);
        // 仅诊断状态/固定词汇，不记录原始请求、错误正文、续接材料或认证信息。
        if (protocol === "responses") {
          const create = model.client.responses.create.bind(
            model.client.responses,
          );
          const note = (error) => {
            const message = String(
              error?.message ?? error?.error?.message ?? "",
            ).toLowerCase();
            result.providerDiagnostics.push({
              status: typeof error?.status === "number" ? error.status : null,
              hints: [
                "reasoning",
                "function_call",
                "call_id",
                "previous",
                "input",
                "message",
                "invalid",
                "tool",
                "missing",
                "not found",
                "must",
                "position",
                "content",
                "output",
                "assistant",
                "user",
                "sequence",
                "index",
                "consecutive",
                "begin",
                "start",
                "end",
                "first",
                "last",
                "same",
                "turn",
                "encrypted",
                "signature",
                "valid",
                "empty",
                "preced",
                "following",
                "replay",
                "block",
                "final",
                "thinking",
                "provide",
                "zero",
                "effort",
                "true",
                "false",
                "non",
                "string",
                "text",
                "summary",
                "continue",
                "hash",
                "budget",
              ].filter((word) => message.includes(word)),
            });
          };
          model.client.responses.create = async (...args) => {
            try {
              const stream = await create(...args);
              return {
                controller: stream.controller,
                async *[Symbol.asyncIterator]() {
                  for await (const event of stream) {
                    if (event.type === "error") note(event);
                    if (event.type === "response.failed")
                      note(event.response.error);
                    yield event;
                  }
                },
              };
            } catch (error) {
              note(error);
              throw error;
            }
          };
        }
        return {
          estimateInput: (...args) => model.estimateInput(...args),
          stream(...args) {
            if (requests >= 32)
              throw new AppError(
                "acceptance_limit",
                "本协议验收请求预算已用尽。",
              );
            requests++;
            if (args[0][0]?.content.includes("你负责整理 Agent"))
              summaryRequests++;
            return model.stream(...args);
          },
        };
      },
    });
    app.settings.save({
      baseUrl: config.baseUrl,
      model: config.model,
      apiProtocol: protocol,
      apiKey: "temporary-placeholder",
      systemPrompt: "请用中文简洁回答，使用项目内已有的方法完成任务。",
      contextWindowTokens: config.contextWindowTokens ?? 200000,
      outputReserveTokens: 4096,
      expectedRevision: 0,
    });
    const session = await app.projects.create({
      requestId: crypto.randomUUID(),
      path: work,
    });
    async function run(content, skillIds) {
      const accepted = app.chat.start(session.id, {
        requestId: crypto.randomUUID(),
        expectedRevision: app.store.snapshot(session.id).session.revision,
        content,
        ...(skillIds ? { skillIds } : {}),
      });
      const end = Date.now() + 240000;
      while (Date.now() < end) {
        const current = app.store.getRun(accepted.run.id);
        if (!isActiveRun(current.status)) {
          assert.equal(
            current.status,
            "succeeded",
            current.error?.code ?? current.status,
          );
          return current;
        }
        if (current.status === "waiting_approval") {
          const approval = app.store.execution
            .list("approvals", { runId: current.id })
            .find((a) => a.status === "pending");
          assert(approval, "缺少审批");
          const invocation = app.store.execution.get(
            "invocations",
            approval.invocationId,
          );
          const command = String(
            JSON.parse(invocation?.arguments ?? "{}").command ?? "",
          );
          assert(
            command.includes("report.mjs") &&
              !approval.resources.some((r) => r.kind === "network"),
            "验收未授权的操作",
          );
          await app.server.inject({
            method: "POST",
            url: `/api/v1/approvals/${approval.id}/decision`,
            payload: {
              requestId: crypto.randomUUID(),
              decision: "allow",
              scope: "once",
            },
          });
          result.approvals++;
        }
        if (
          ["waiting_context", "waiting_reconciliation", "recoverable"].includes(
            current.status,
          )
        )
          throw new AppError(
            "acceptance_paused",
            `验收暂停：${current.status}`,
          );
        await delay(100);
      }
      throw new AppError("acceptance_timeout", "验收任务超时。");
    }
    const first = await run(
      "请按本项目的销售报表规范，统计 data/sales.csv 的月度金额，生成报告并校验总额。",
    );
    const invocations = app.store.execution.list("invocations", {
      runId: first.id,
    });
    result.tools = invocations.map((i) => i.toolName);
    assert(result.tools.includes("load_skill"), "模型未自主加载技能");
    assert(
      result.tools.includes("read_skill_resource"),
      "模型未按需读取参考资料",
    );
    assert(result.tools.includes("exec_command"), "模型未执行技能脚本");
    assert(
      readFileSync(join(work, "reports/sales.md"), "utf8").includes("总额：42"),
    );
    assert(summaryRequests > 0, "未触发上下文压缩");
    const entry = app.skills.catalog(session.workspaceId).entries[0];
    const explicit = await run(
      "仅说明这份报表规范的关键标识，不执行任何工具。",
      [entry.id],
    );
    assert(app.store.skills.get("runs", explicit.id).active.length === 1);
    const next = await run("只回复你好，不使用工具或项目规范。");
    result.nextRunInherited =
      app.store.skills.get("runs", next.id).active.length > 0;
    assert.equal(result.nextRunInherited, false);
    result.ok = true;
  } catch (error) {
    result.error =
      error instanceof AppError
        ? error.code
        : error instanceof assert.AssertionError
          ? error.message
          : "验收失败，未记录可能含敏感数据的底层错误";
    process.exitCode = 1;
  } finally {
    result.requests = requests;
    result.summaryRequests = summaryRequests;
    if (app) {
      await app.server.close();
      app.skills.files.collect(new Set());
    }
    rmSync(root, { recursive: true, force: true });
    report.protocols.push(result);
    console.info(JSON.stringify(result));
  }
}
report.originalSettingsUnchanged = original() === before;
assert(report.originalSettingsUnchanged);
mkdirSync(".cache/acceptance", { recursive: true });
writeFileSync(
  `.cache/acceptance/skills-live${process.env.MYAGENT_SKILL_LIVE_PROTOCOL ? `-${process.env.MYAGENT_SKILL_LIVE_PROTOCOL}` : ""}.json`,
  JSON.stringify(report, null, 2),
);
