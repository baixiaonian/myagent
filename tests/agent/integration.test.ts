/**
 * 双协议产品链路验收：官方 SDK 访问真实 loopback HTTP，运行真实工具并写入 SQLite。
 * 每例独立临时实例；测试私有续接不泄漏、协议快照、迁移和事件恢复，不使用真实凭证。
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import { SqliteChatStore } from "../../packages/adapters/src/index.js";
import type {
  ApiProtocol,
  ChatEvent,
  Run,
} from "../../packages/contracts/src/index.js";
import { isActiveRun } from "../../packages/contracts/src/index.js";
import { applyEvent } from "../../packages/sdk/src/index.js";
import { mockProvider } from "../chat/provider.js";

let dir: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let provider: Awaited<ReturnType<typeof mockProvider>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myagent-loop-"));
  provider = await mockProvider();
  app = await buildServer({ dataDir: dir, serveWeb: false });
});
afterEach(async () => {
  await app.server.close();
  await provider.close();
  rmSync(dir, { recursive: true, force: true });
});
function configure(apiProtocol: ApiProtocol, model = "test") {
  app.settings.save({
    apiProtocol,
    baseUrl: provider.url,
    model,
    apiKey: "sk-agent-fixture",
    systemPrompt: "",
    expectedRevision: app.settings.get().revision,
  });
}
async function end(id: string) {
  await expect
    .poll(() => isActiveRun(app.store.getRun(id).status), { timeout: 5000 })
    .toBe(false);
  return app.store.getRun(id);
}
describe.each<ApiProtocol>(["responses", "chat_completions"])(
  "%s agent path",
  (protocol) => {
    it("executes real tools, updates plan and keeps private continuation off public state", async () => {
      configure(protocol);
      const session = app.store.createSession();
      const before = app.store.snapshot(session.id);
      const input = {
        requestId: randomUUID(),
        expectedRevision: 0,
        content: "Agent 查询时间并更新计划",
      };
      const accepted = app.chat.start(session.id, input);
      expect(app.chat.start(session.id, input).run.id).toBe(accepted.run.id);
      expect((await end(accepted.run.id)).status).toBe("succeeded");
      expect(provider.requests).toHaveLength(3);
      const after = app.store.snapshot(session.id);
      expect(after.steps).toHaveLength(3);
      expect(after.messages.at(-1)?.content).toBe(
        "Agent 任务已完成，已查询时间并更新计划。",
      );
      expect(after.steps?.[0]?.tools[1]?.result?.data).toHaveProperty(
        "timezone",
        "Asia/Shanghai",
      );
      expect(after.steps?.[1]?.tools[0]?.result?.data).toHaveProperty(
        "explanation",
        "已获得真实工具结果",
      );
      expect(JSON.stringify(after)).not.toContain("private-reasoning-fixture");
      expect(JSON.stringify(app.store.events(session.id, 0))).not.toContain(
        "private-reasoning-fixture",
      );
      expect(JSON.stringify(app.store.getSteps(accepted.run.id))).toContain(
        "private-reasoning-fixture",
      );
      let projection = before;
      for (const event of app.store.events(session.id, 0)) {
        projection = applyEvent(projection, event);
        projection = applyEvent(projection, event);
      }
      expect(projection).toEqual(after);
      if (protocol === "responses") {
        expect(provider.requests[1]?.store).toBe(false);
        expect(provider.requests[1]).not.toHaveProperty("previous_response_id");
        expect(provider.requests[1]?.input?.map((item) => item.type)).toEqual([
          undefined,
          "reasoning",
          "message",
          "function_call",
          "function_call",
          "function_call_output",
          "function_call_output",
        ]);
      } else
        expect(provider.requests[1]?.messages[1]?.reasoning_content).toBe(
          "private-reasoning-fixture",
        );
      const next = app.chat.start(session.id, {
        requestId: randomUUID(),
        expectedRevision: after.session.revision,
        content: "继续",
      });
      expect((await end(next.run.id)).status).toBe("succeeded");
      expect(JSON.stringify(provider.requests[3])).toContain(
        "private-reasoning-fixture",
      );
      await app.server.close();
      app = await buildServer({ dataDir: dir, serveWeb: false });
      expect(app.store.snapshot(session.id).steps).toHaveLength(4);
    });
    it("pins protocol while running, isolates regeneration failure and late writes", async () => {
      configure(protocol, "slow");
      const session = app.store.createSession();
      const first = app.chat.start(session.id, {
        requestId: "first",
        expectedRevision: 0,
        content: "Agent 测试",
      });
      configure(
        protocol === "responses" ? "chat_completions" : "responses",
        "unauthorized",
      );
      expect((await end(first.run.id)).status).toBe("succeeded");
      expect(app.store.getRun(first.run.id).apiProtocol).toBe(protocol);
      const original = app.store.snapshot(session.id);
      const retry = app.chat.start(
        session.id,
        { requestId: "retry", expectedRevision: original.session.revision },
        "regenerate",
      );
      expect((await end(retry.run.id)).status).toBe("failed");
      const after = app.store.snapshot(session.id);
      expect(
        after.messages.find((m) => m.id === first.run.assistantMessageId)
          ?.status,
      ).toBe("completed");
      expect(after.steps?.filter((s) => s.runId === first.run.id)).toEqual(
        original.steps,
      );
      const record = app.store.getSteps(first.run.id)[0];
      if (!record) throw new Error("Missing completed step");
      await app.chat.deleteSession(session.id);
      expect(app.store.saveStep(record)).toBe(false);
      expect(app.store.getSteps(first.run.id)).toEqual([]);
    });
  },
);
it("v1 migration preserves old config, history and events, and marks unfinished steps interrupted", async () => {
  await app.server.close();
  const path = join(dir, "legacy.db");
  const require = createRequire(
    new URL("../../packages/adapters/package.json", import.meta.url),
  );
  const Database = require("better-sqlite3") as new (
    path: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): void };
    close(): void;
  };
  const raw = new Database(path);
  raw.exec(
    readFileSync(
      new URL("../../migrations/0001_chat.sql", import.meta.url),
      "utf8",
    ),
  );
  raw.exec(
    `INSERT INTO settings VALUES(1, '{"baseUrl":"https://example.com","model":"legacy","systemPrompt":"","credentialRef":null,"revision":0,"updatedAt":"old"}'); PRAGMA user_version=1;`,
  );
  // 升级前实际写入 v1 消息、Run 和事件；迁移不可为它们补造 Step 或改写旧事件版本。
  const legacyRun: Run = {
    id: "legacy-run",
    sessionId: "legacy-session",
    requestId: "legacy-request",
    fingerprint: "old",
    kind: "send",
    status: "succeeded",
    userMessageId: "legacy-question",
    assistantMessageId: "legacy-answer",
    originalAssistantId: null,
    model: "legacy",
    contextTrimmed: false,
    finishReason: "stop",
    usage: null,
    error: null,
    createdAt: "old",
    endedAt: "old",
  };
  const legacyEvent: ChatEvent = {
    schemaVersion: 1,
    sessionId: "legacy-session",
    seq: 1,
    createdAt: "old",
    type: "run.updated",
    run: legacyRun,
  };
  raw.exec(
    "INSERT INTO sessions VALUES('legacy-session','旧对话',1,1,'old','old'); INSERT INTO messages VALUES('legacy-question','legacy-session','legacy-run','user','旧问题','completed',NULL,'old'); INSERT INTO messages VALUES('legacy-answer','legacy-session','legacy-run','assistant','旧回答','completed','legacy-question','old');",
  );
  raw
    .prepare("INSERT INTO runs VALUES(?,?,?,?,?)")
    .run(
      legacyRun.id,
      legacyRun.sessionId,
      legacyRun.requestId,
      legacyRun.status,
      JSON.stringify(legacyRun),
    );
  raw
    .prepare("INSERT INTO events VALUES(?,?,?)")
    .run(legacyEvent.sessionId, legacyEvent.seq, JSON.stringify(legacyEvent));
  raw.close();
  const store = new SqliteChatStore(path);
  expect(store.settings().apiProtocol).toBe("chat_completions");
  const legacy = store.snapshot("legacy-session");
  expect(legacy.steps).toEqual([]);
  expect(legacy.messages.map((m) => m.content)).toEqual(["旧问题", "旧回答"]);
  expect(legacy.latestRun).toEqual(legacyRun);
  expect(store.events("legacy-session", 0)).toEqual([legacyEvent]);
  expect(
    applyEvent({ ...legacy, cursor: 0, latestRun: null }, legacyEvent),
  ).toEqual(legacy);
  const session = store.createSession();
  const run = store.beginRun({
    sessionId: session.id,
    expectedRevision: 0,
    requestId: "old",
    fingerprint: "old",
    kind: "send",
    content: "question",
    model: "legacy",
    contextTrimmed: false,
  });
  store.saveStep({
    identity: "test",
    continuation: null,
    step: {
      id: "step",
      runId: run.id,
      index: 1,
      status: "tools",
      content: "准备",
      finishReason: "tool_calls",
      usage: null,
      error: null,
      createdAt: "old",
      endedAt: null,
      tools: [
        {
          id: "call",
          name: "get_current_time",
          arguments: "{}",
          status: "running",
          result: null,
        },
      ],
    },
  });
  store.recoverInterrupted();
  expect(store.getRun(run.id).status).toBe("interrupted");
  expect(store.getSteps(run.id)[0]?.step.tools[0]?.status).toBe("interrupted");
  store.close();
});

// Responses 的错误也必须经过与 Chat 相同的脱敏、取消边界，不能只测成功文本流。
describe("responses failure boundaries", () => {
  it.each([
    ["unauthorized", "model_auth"],
    ["payment", "model_payment_required"],
    ["missing", "model_not_found"],
    ["limited", "model_rate_limit"],
    ["bad", "model_request"],
    ["broken", "incomplete_stream"],
  ])("maps %s without retry or credential echo", async (model, code) => {
    configure("responses", model);
    const session = app.store.createSession();
    const accepted = app.chat.start(session.id, {
      requestId: "error",
      expectedRevision: 0,
      content: "hello",
    });
    expect((await end(accepted.run.id)).error?.code).toBe(code);
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(app.store.snapshot(session.id))).not.toContain(
      "sk-agent-fixture",
    );
  });
  it("cancels a real hanging HTTP stream and preserves terminal state", async () => {
    configure("responses", "hang");
    const session = app.store.createSession();
    const accepted = app.chat.start(session.id, {
      requestId: "cancel",
      expectedRevision: 0,
      content: "hello",
    });
    await expect.poll(() => provider.requests.length).toBe(1);
    await app.chat.cancel(accepted.run.id);
    expect(app.store.getRun(accepted.run.id).status).toBe("cancelled");
    expect(app.store.snapshot(session.id).steps?.[0]?.status).toBe("cancelled");
    await expect.poll(() => provider.cancelled).toBe(1);
  });
  it("uses a plain historical answer after changing protocol", async () => {
    configure("responses");
    const session = app.store.createSession();
    const first = app.chat.start(session.id, {
      requestId: "a",
      expectedRevision: 0,
      content: "Agent 查询时间",
    });
    await end(first.run.id);
    configure("chat_completions");
    const next = app.chat.start(session.id, {
      requestId: "b",
      expectedRevision: app.store.snapshot(session.id).session.revision,
      content: "继续",
    });
    expect((await end(next.run.id)).status).toBe("succeeded");
    expect(provider.requests.at(-1)?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(provider.requests.at(-1))).not.toContain(
      "private-reasoning-fixture",
    );
  });
});
