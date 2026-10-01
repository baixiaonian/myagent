/**
 * 上下文产品集成：真实 SQLite/工具记录/API 加可控模型，验证暂停重启后不重放工具。
 * 不使用用户目录或真实密钥；双协议实际 HTTP 的估算一致性另由 protocol 测试覆盖。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import { AppError, isActiveRun } from "../../packages/contracts/dist/index.js";
import type { ModelPort } from "../../packages/kernel/src/index.js";

let app: Awaited<ReturnType<typeof buildServer>> | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await app?.server.close();
  app = undefined;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "myagent-context-integration-"));
  dirs.push(dir);
  return dir;
};
const configure = () =>
  app?.settings.save({
    baseUrl: "http://127.0.0.1:1/v1",
    apiProtocol: "responses",
    model: "fixture",
    apiKey: "test-only",
    systemPrompt: "",
    // 用固定小窗口触发压缩边界，不让产品默认容量改变故障恢复场景。
    contextWindowTokens: 32768,
    outputReserveTokens: 4096,
    expectedRevision: app.settings.get().revision,
  });
it("单轮累计输出超过 20 万字符时持续压缩并完成，工具与原文记录均保留", async () => {
  let decisions = 0;
  let summaries = 0;
  let generated = 0;
  const model: ModelPort = {
    async *stream(messages, _signal, tools) {
      if (messages[0]?.content.startsWith("你负责整理 Agent")) {
        summaries++;
        expect(tools).toEqual([]);
        yield {
          type: "text",
          text: "已完成若干轮时间核验，原始证据仍在历史记录中，继续剩余步骤。",
        };
        yield { type: "done", finishReason: "stop", usage: null };
        return;
      }
      decisions++;
      if (decisions <= 8) {
        // 每次仅产生一个完整批次，借真实 ContextService 压缩旧步骤；不人为扩大模型窗口。
        const content = `第 ${decisions} 次核验：${"已保存排查事实。".repeat(4000)}`;
        generated += content.length;
        yield { type: "text", text: content };
        yield {
          type: "done",
          finishReason: "tool_calls",
          usage: null,
          response: {
            content,
            continuation: { privateReasoning: "PRIVATE_OBSERVATION_BOUNDARY" },
            toolCalls: [
              {
                id: `clock-${decisions}`,
                name: "get_current_time",
                arguments: "{}",
              },
            ],
          },
        };
      } else {
        expect(JSON.stringify(messages)).toContain("历史资料摘要");
        yield { type: "text", text: "长任务已完成。" };
        yield { type: "done", finishReason: "stop", usage: null };
      }
    },
  };
  app = await buildServer({
    dataDir: directory(),
    serveWeb: false,
    modelFactory: () => model,
  });
  configure();
  const session = app.store.createSession();
  const accepted = app.chat.start(session.id, {
    requestId: "long-task",
    expectedRevision: 0,
    content: "持续核验并整理结果。",
  });
  await expect
    .poll(() => isActiveRun(app?.store.getRun(accepted.run.id).status ?? ""), {
      timeout: 15000,
    })
    .toBe(false);
  expect(app.store.getRun(accepted.run.id).status).toBe("succeeded");
  expect(generated).toBeGreaterThan(200000);
  expect(decisions).toBe(9);
  expect(summaries).toBeGreaterThan(1);
  const snapshot = app.store.snapshot(session.id);
  const steps = snapshot.steps ?? [];
  expect(steps.filter((step) => step.runId === accepted.run.id)).toHaveLength(
    9,
  );
  expect(
    steps.reduce((sum, step) => sum + step.content.length, 0),
  ).toBeGreaterThan(200000);
  expect(
    app.store.execution.list("invocations", { runId: accepted.run.id }),
  ).toHaveLength(8);
  expect(snapshot.messages.at(-1)?.content).toBe("长任务已完成。");
  const spans = app.store.observations.list("spans");
  for (const context of spans.filter(
    (span) => span.name === "context.prepare",
  )) {
    const step = spans.find((span) => span.id === context.parentId)!;
    expect(step.name).toBe("agent.step");
    expect(step.startedAt <= context.startedAt).toBe(true);
    expect(step.scope.stepId).toBe(context.scope.stepId);
  }
  for (const summary of spans.filter(
    (span) => span.name === "context.compact",
  )) {
    expect(spans.find((span) => span.id === summary.parentId)?.name).toBe(
      "context.prepare",
    );
    expect(
      spans.some(
        (span) =>
          span.name === "gen_ai.request" &&
          span.parentId === summary.id &&
          span.scope.purpose === "summary",
      ),
    ).toBe(true);
  }
  const events = app.store.observations.list("events");
  expect(events.some((event) => event.name === "context.added")).toBe(true);
  expect(
    events
      .filter((event) => event.name === "context.prepared")
      .every(
        (event) =>
          spans.find((span) => span.id === event.spanId)?.name ===
          "context.prepare",
      ),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain("PRIVATE_OBSERVATION_BOUNDARY");
  const observed = spans.find((span) => span.name === "agent.step")!;
  const evidence = await app.server.inject({
    method: "GET",
    url: `/api/v1/observability/traces/${observed.traceId}/spans/${observed.id}/evidence`,
  });
  expect(evidence.statusCode).toBe(200);
  expect(evidence.json().step.id).toBe(observed.scope.stepId);
  expect(evidence.body).not.toContain("PRIVATE_OBSERVATION_BOUNDARY");
  expect(
    (
      await app.server.inject({
        method: "GET",
        url: `/api/v1/observability/traces/wrong/spans/${observed.id}/evidence`,
      })
    ).statusCode,
  ).toBe(404);
});
it("大单轮压缩失败后暂停，重启恢复不重复工具，容量更新不更换连接，重复继续幂等", async () => {
  const dir = directory();
  let decisionCalls = 0,
    summaryCalls = 0,
    fail = true;
  const protocols: string[] = [];
  const factory = (settings: { apiProtocol: string }): ModelPort => {
    protocols.push(settings.apiProtocol);
    return {
      async *stream(messages, _signal, tools) {
        if (messages[0]?.content.startsWith("你负责整理 Agent")) {
          summaryCalls++;
          expect(tools).toEqual([]);
          if (fail)
            throw new AppError("model_connection", "测试摘要请求失败。");
          yield {
            type: "text",
            text: "已查询系统时间；保留结果记录，继续回答原问题。",
          };
          yield {
            type: "done",
            finishReason: "stop",
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          };
          return;
        }
        decisionCalls++;
        if (decisionCalls === 1) {
          const content = "排查过程中的已知事实。".repeat(3000);
          yield { type: "text", text: content };
          yield {
            type: "done",
            finishReason: "tool_calls",
            usage: null,
            response: {
              content,
              toolCalls: [
                { id: "clock", name: "get_current_time", arguments: "{}" },
              ],
              continuation: {
                protocol: "responses",
                items: [{ type: "reasoning", encrypted_content: "PRIVATE" }],
              },
            },
          };
        } else {
          expect(JSON.stringify(messages)).toContain("历史资料摘要");
          yield { type: "text", text: "压缩后继续成功。" };
          yield { type: "done", finishReason: "stop", usage: null };
        }
      },
    };
  };
  app = await buildServer({
    dataDir: dir,
    workspaceRoot: join(dir, "workspaces-separate"),
    serveWeb: false,
    modelFactory: factory,
  });
  configure();
  const session = app.store.createSession();
  const accepted = app.chat.start(session.id, {
    requestId: "first",
    expectedRevision: 0,
    content: "读取时间并继续处理",
  });
  await expect
    .poll(() => app?.store.getRun(accepted.run.id).status, { timeout: 5000 })
    .toBe("waiting_context");
  expect(decisionCalls).toBe(1);
  expect(
    app.store.execution.get("checkpoints", accepted.run.id)?.limits
      .historyTurns,
  ).toBe(3);
  expect(summaryCalls).toBe(1);
  expect(
    app.store.execution.list("invocations", { runId: accepted.run.id }),
  ).toHaveLength(1);
  await app.server.close();
  app = await buildServer({
    dataDir: dir,
    workspaceRoot: join(dir, "workspaces-separate"),
    serveWeb: false,
    modelFactory: factory,
  });
  expect(app.store.getRun(accepted.run.id).status).toBe("recoverable");
  expect(decisionCalls).toBe(1);
  app.settings.save({
    ...app.settings.get(),
    apiProtocol: "chat_completions",
    contextWindowTokens: 40000,
    expectedRevision: app.settings.get().revision,
  });
  fail = false;
  const input = {
    requestId: "resume-1",
    contextAction: "apply_capacity" as const,
  };
  await app.chat.resume(accepted.run.id, input);
  await expect
    .poll(() => isActiveRun(app?.store.getRun(accepted.run.id).status ?? ""), {
      timeout: 5000,
    })
    .toBe(false);
  expect(app.store.getRun(accepted.run.id).status).toBe("succeeded");
  expect(decisionCalls).toBe(2);
  expect(
    app.store.execution.list("invocations", { runId: accepted.run.id }),
  ).toHaveLength(1);
  expect(protocols).toEqual(["responses", "responses"]);
  expect(
    app.store.context.get("runs", accepted.run.id)?.capacity
      .contextWindowTokens,
  ).toBe(40000);
  const count = summaryCalls;
  await app.chat.resume(accepted.run.id, input);
  expect(summaryCalls).toBe(count);
  const context = await app.server.inject({
    method: "GET",
    url: `/api/v1/sessions/${session.id}/context`,
  });
  expect(context.statusCode).toBe(200);
  expect(context.body).not.toContain("PRIVATE");
  expect(context.json().summaries.length).toBeGreaterThan(0);
  const history = await app.server.inject({
    method: "GET",
    url: `/api/v1/sessions/${session.id}/history?includeSuperseded=true`,
  });
  expect(history.statusCode).toBe(200);
  expect(history.body).not.toContain("PRIVATE");
  expect(
    app.store
      .events(session.id, 0)
      .some((e) => e.type === "context.updated" && e.schemaVersion === 4),
  ).toBe(true);
});
it("摘要共享只覆盖成功分支，失败候选不覆盖原摘要；历史工具真实注册且只读", async () => {
  let calls = 0;
  const model: ModelPort = {
    async *stream(messages) {
      if (messages[0]?.content.startsWith("你负责整理 Agent")) {
        yield { type: "text", text: "历史问题已回答。" };
        yield { type: "done", finishReason: "stop", usage: null };
        return;
      }
      if (++calls === 3) throw new AppError("model_connection", "候选失败");
      yield { type: "text", text: "历史回答。".repeat(1000) };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
  app = await buildServer({
    dataDir: directory(),
    serveWeb: false,
    modelFactory: () => model,
    contextTriggerRatio: 0.15,
  });
  configure();
  const session = app.store.createSession();
  const runningApp = app;
  const send = async (content: string) => {
    const r = runningApp.chat.start(session.id, {
      requestId: crypto.randomUUID(),
      expectedRevision: runningApp.store.snapshot(session.id).session.revision,
      content,
    });
    await expect
      .poll(() => isActiveRun(runningApp.store.getRun(r.run.id).status))
      .toBe(false);
    return r.run;
  };
  await send("第一个问题");
  const original = await send("第二个问题");
  const summaries = app.store.context.get("runs", original.id)?.summaryIds;
  expect(summaries?.length).toBeGreaterThan(0);
  const retry = app.chat.start(
    session.id,
    {
      requestId: "retry",
      expectedRevision: app.store.snapshot(session.id).session.revision,
    },
    "regenerate",
  );
  await expect
    .poll(() => isActiveRun(runningApp.store.getRun(retry.run.id).status))
    .toBe(false);
  expect(app.store.getRun(retry.run.id).status).toBe("failed");
  expect(app.store.context.get("runs", original.id)?.summaryIds).toEqual(
    summaries,
  );
  expect(app.contexts.view(session.id)?.runId).toBe(original.id);
  expect(
    app.store
      .snapshot(session.id)
      .messages.find((m) => m.id === original.assistantMessageId)?.status,
  ).toBe("completed");
  const tool = app.registry
    .descriptors()
    .find((t) => t.name === "read_conversation_history");
  expect(tool?.effects).toBe("read");
});
