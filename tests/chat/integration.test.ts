/**
 * 聊天集成回归：以真实本地 HTTP 假模型、SQLite 和 Server 装配验证持久化与协议边界。
 * 覆盖幂等、SSE 重放、取消、重启、迟到写入、配置及凭证脱敏；每例独立临时目录。
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import type { Run, Session } from "../../packages/contracts/src/index.js";
import { applyEvent } from "../../packages/sdk/src/index.js";
import { mockProvider } from "./provider.js";

const KEY = "sk-fixture-only-never-a-real-key";
let provider: Awaited<ReturnType<typeof mockProvider>>;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir: string;
async function configure(model = "test") {
  const result = await app.server.inject({
    method: "PUT",
    url: "/api/v1/settings",
    payload: {
      baseUrl: provider.url,
      model,
      apiKey: KEY,
      systemPrompt: "用中文",
      expectedRevision: app.settings.get().revision,
    },
  });
  expect(result.statusCode).toBe(200);
  return result.json();
}
function start(id: string, revision: number, content = "你好") {
  return app.chat.start(id, {
    requestId: randomUUID(),
    expectedRevision: revision,
    content,
  });
}
// 轮询真实仓储终态而非假定固定耗时，让用例同时覆盖异步生成和最终持久化。
async function terminal(id: string): Promise<Run> {
  await expect
    .poll(() => app.store.getRun(id).status, { timeout: 4000 })
    .not.toBe("running");
  return app.store.getRun(id);
}
// 每个用例独占数据目录与临时模型端口，防止历史、凭证或活动 Run 在用例之间串扰。
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myagent-test-"));
  provider = await mockProvider();
  app = await buildServer({ dataDir: dir, serveWeb: false });
});
afterEach(async () => {
  await app.server.close();
  await provider.close();
  rmSync(dir, { recursive: true, force: true });
});
describe("durable chat over real compatible HTTP", () => {
  it("requires configuration and round trips multiple turns, SSE replay and deduplication", async () => {
    const session = app.store.createSession();
    const before = app.store.snapshot(session.id);
    expect(() => start(session.id, 0)).toThrow(/设置/);
    await configure();
    const one = start(session.id, 0);
    expect((await terminal(one.run.id)).status).toBe("succeeded");
    const first = app.store.snapshot(session.id);
    const two = start(session.id, first.session.revision, "继续");
    await terminal(two.run.id);
    expect(provider.requests[1]?.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(Object.keys(provider.requests[0] ?? {}).sort()).toEqual([
      "messages",
      "model",
      "stream",
    ]);
    expect(app.store.getRun(two.run.id).usage).toBeNull();
    // 同一事件应用两次后仍应与数据库快照一致，验证幂等投影而不仅是事件条数。
    const events = app.store.events(session.id, 0);
    let reduced = before;
    for (const event of events) {
      reduced = applyEvent(reduced, event);
      reduced = applyEvent(reduced, event);
    }
    expect(reduced).toEqual(app.store.snapshot(session.id));
    const address = await app.server.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(
      `${address}/api/v1/sessions/${session.id}/events?after=0`,
      {
        signal: controller.signal,
        headers: { "Last-Event-ID": String(first.cursor) },
      },
    );
    if (!response.body) throw new Error("Missing SSE stream");
    const chunk = new TextDecoder().decode(
      (await response.body.getReader().read()).value,
    );
    controller.abort();
    expect(chunk).toContain(`id: ${first.cursor + 1}\n`);
    expect(chunk).not.toContain(`id: ${first.cursor}\n`);
    expect(app.store.snapshot(session.id).messages).toHaveLength(4);
  });
  it("enforces idempotency, revision conflicts and one active run", async () => {
    await configure("slow");
    const s = app.store.createSession();
    const input = { requestId: "same", expectedRevision: 0, content: "你好" };
    const one = app.chat.start(s.id, input);
    expect(app.chat.start(s.id, input).run.id).toBe(one.run.id);
    expect(() =>
      app.chat.start(s.id, { ...input, content: "different" }),
    ).toThrow(/请求标识/);
    expect(() => start(s.id, 1)).toThrow(/正在生成/);
    await app.chat.cancel(one.run.id);
    expect(() => start(s.id, 0)).toThrow(/更新/);
    expect(
      app.store.snapshot(s.id).messages.filter((m) => m.role === "user"),
    ).toHaveLength(1);
    expect(provider.requests.length).toBeLessThanOrEqual(1);
  });
  it("replaces original answer only when regeneration succeeds", async () => {
    await configure();
    const s = app.store.createSession();
    const first = start(s.id, 0);
    await terminal(first.run.id);
    await configure("unauthorized");
    const retry = app.chat.start(
      s.id,
      {
        requestId: randomUUID(),
        expectedRevision: app.store.snapshot(s.id).session.revision,
      },
      "regenerate",
    );
    await terminal(retry.run.id);
    expect(
      app.store
        .snapshot(s.id)
        .messages.find((m) => m.id === first.run.assistantMessageId)?.status,
    ).toBe("completed");
    await configure();
    const retry2 = app.chat.start(
      s.id,
      {
        requestId: randomUUID(),
        expectedRevision: app.store.snapshot(s.id).session.revision,
      },
      "regenerate",
    );
    await terminal(retry2.run.id);
    const after = app.store.snapshot(s.id);
    expect(
      after.messages.find((m) => m.id === first.run.assistantMessageId)?.status,
    ).toBe("superseded");
    expect(after.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });
  it("persists before emitting; refresh does not stop and cancellation reaches the provider", async () => {
    await configure("slow");
    const s = app.store.createSession();
    const run = start(s.id, 0, "很长的慢速回答测试请详细解释每一部分");
    await expect
      .poll(() => app.store.snapshot(s.id).messages[1]?.content.length ?? 0)
      .toBeGreaterThan(0);
    const refreshed = app.store.snapshot(s.id);
    expect(refreshed.activeRun?.id).toBe(run.run.id);
    const settings = app.settings.get();
    await configure("missing");
    expect(settings.model).toBe("slow");
    expect((await app.chat.cancel(run.run.id)).status).toBe("cancelled");
    expect(
      app.store.snapshot(s.id).messages[1]?.content.length,
    ).toBeGreaterThan(0);
    await expect.poll(() => provider.cancelled).toBe(1);
    expect(provider.requests[0]?.model).toBe("slow");
  });
  it("deletes active sessions and ignores late writes", async () => {
    await configure("slow");
    const s = app.store.createSession();
    const run = start(s.id, 0);
    await app.chat.deleteSession(s.id);
    app.store.appendDelta(run.run.id, "late");
    app.store.finishRun(run.run.id, {
      status: "succeeded",
      finishReason: "stop",
      usage: null,
      error: null,
    });
    expect(app.store.listSessions()).toEqual([]);
    expect(() => app.store.snapshot(s.id)).toThrow();
  });
  it("marks orphan runs interrupted across restart and persists settings and history", async () => {
    await configure();
    const s = app.store.createSession();
    // 直接写入 running 但不创建内存执行句柄，模拟进程退出遗留；重启不得因此再次调用模型。
    const orphan = app.store.beginRun({
      sessionId: s.id,
      expectedRevision: 0,
      requestId: "crashed",
      fingerprint: "x",
      kind: "send",
      content: "问题",
      model: "test",
      contextTrimmed: false,
    });
    app.store.appendDelta(orphan.id, "部分回答");
    await app.server.close();
    app = await buildServer({ dataDir: dir, serveWeb: false });
    expect(app.store.getRun(orphan.id).status).toBe("interrupted");
    expect(app.store.snapshot(s.id).messages[1]?.content).toBe("部分回答");
    expect(app.settings.get().configured).toBe(true);
    expect(provider.requests).toHaveLength(0);
  });
  it("rejects a second server using the same data directory", async () => {
    await expect(buildServer({ dataDir: dir })).rejects.toThrow();
  });
});
describe("protocol, errors and credentials", () => {
  it.each([
    ["unauthorized", "model_auth"],
    ["missing", "model_not_found"],
    ["limited", "model_rate_limit"],
    ["bad", "model_request"],
    ["broken", "incomplete_stream"],
  ])("maps %s without upstream secrets or retries", async (model, code) => {
    await configure(model);
    const s = app.store.createSession();
    const run = start(s.id, 0);
    const done = await terminal(run.run.id);
    expect(done.error?.code).toBe(code);
    expect(JSON.stringify(done)).not.toContain(KEY);
    expect(provider.requests).toHaveLength(1);
  });
  it("times out real HTTP streams and leaves terminal state", async () => {
    await app.server.close();
    app = await buildServer({ dataDir: dir, serveWeb: false, timeoutMs: 60 });
    await configure("hang");
    const s = app.store.createSession();
    const run = start(s.id, 0);
    expect((await terminal(run.run.id)).error?.code).toBe("timeout");
  });
  it("tests actual unsaved configuration without persisting it or chat history", async () => {
    const result = await app.server.inject({
      method: "POST",
      url: "/api/v1/settings/test",
      payload: {
        baseUrl: provider.url,
        model: "test",
        apiKey: KEY,
        systemPrompt: "",
        expectedRevision: 0,
      },
    });
    expect(result.statusCode).toBe(200);
    expect(app.store.listSessions()).toEqual([]);
    expect(app.settings.get().hasKey).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });
  it("keeps secrets only in permission-restricted credentials, supports keep/replace/clear", async () => {
    const configured = await configure();
    expect(JSON.stringify(configured)).not.toContain(KEY);
    const saved = await app.server.inject({
      method: "GET",
      url: "/api/v1/settings",
    });
    expect(saved.body).not.toContain(KEY);
    expect(saved.body).not.toContain("credentialRef");
    const second = {
      baseUrl: provider.url,
      model: "test2",
      systemPrompt: "",
      expectedRevision: configured.revision,
    };
    expect(
      (
        await app.server.inject({
          method: "PUT",
          url: "/api/v1/settings",
          payload: second,
        })
      ).json().hasKey,
    ).toBe(true);
    expect(readFileSync(join(dir, "state.db")).includes(Buffer.from(KEY))).toBe(
      false,
    );
    expect(
      readFileSync(join(dir, "state.db-wal")).includes(Buffer.from(KEY)),
    ).toBe(false);
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    await configure();
    expect(
      Object.keys(
        JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")),
      ),
    ).toHaveLength(1);
    const cleared = app.settings.save({
      ...second,
      expectedRevision: app.settings.get().revision,
      clearKey: true,
    });
    expect(cleared.hasKey).toBe(false);
    expect(readFileSync(join(dir, "credentials.json"), "utf8")).not.toContain(
      KEY,
    );
  });
  it("checks host, origin, content type and input schema", async () => {
    for (const headers of [
      { host: "evil.example" },
      { host: "localhost", origin: "https://evil.example" },
      { host: "localhost", "sec-fetch-site": "cross-site" },
    ])
      expect(
        (
          await app.server.inject({
            method: "GET",
            url: "/api/v1/settings",
            headers,
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/v1/sessions",
          payload: "x",
          headers: { "content-type": "text/plain" },
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (
        await app.server.inject({
          method: "PUT",
          url: "/api/v1/settings",
          payload: { apiKey: KEY },
        })
      ).statusCode,
    ).toBe(400);
    const session = (
      await app.server.inject({
        method: "POST",
        url: "/api/v1/sessions",
        payload: {},
      })
    ).json<Session>();
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/v1/sessions/${session.id}/runs`,
          payload: {
            content: "x".repeat(8001),
            requestId: "x",
            expectedRevision: 0,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.server.inject({
          method: "GET",
          url: `/api/v1/sessions/${session.id}/events?after=100`,
        })
      ).statusCode,
    ).toBe(400);
  });
});

it("does not expose a provider-echoed key in errors or logs", async () => {
  await app.server.close();
  // 收集实际日志器输出，同时检查错误响应，防止只做 API 脱敏却把上游密钥写进日志。
  const logs: string[] = [];
  app = await buildServer({
    dataDir: dir,
    serveWeb: false,
    logger: true,
    logSink: {
      write(message) {
        logs.push(message);
      },
    },
  });
  const response = await app.server.inject({
    method: "POST",
    url: "/api/v1/settings/test",
    payload: {
      baseUrl: provider.url,
      model: "unauthorized",
      apiKey: KEY,
      systemPrompt: "",
      expectedRevision: 0,
    },
  });
  expect(response.statusCode).toBe(502);
  expect(response.body).not.toContain(KEY);
  expect(logs.join("")).not.toContain(KEY);
  expect(logs.join("")).toContain("model_auth");
});

it("maps failed network connections without automatically retrying", async () => {
  await configure();
  await provider.close();
  const s = app.store.createSession();
  const run = start(s.id, 0);
  expect((await terminal(run.run.id)).error?.code).toBe("model_connection");
  // afterEach 仍需要一个可关闭的测试服务器。
  provider = await mockProvider();
});

it("starts with a writable mounted data directory and a read-only parent", async () => {
  await app.server.close();
  const parent = join(dir, "readonly-parent");
  const mounted = join(parent, "data");
  mkdirSync(mounted, { recursive: true, mode: 0o700 });
  // 模拟容器挂载卷父目录只读；finally 恢复权限仅用于清理本例临时目录。
  chmodSync(parent, 0o555);
  try {
    app = await buildServer({ dataDir: mounted, serveWeb: false });
    expect(
      (await app.server.inject({ method: "GET", url: "/healthz" })).statusCode,
    ).toBe(200);
    expect(existsSync(join(mounted, "server.lock"))).toBe(true);
    expect(existsSync(`${mounted}.lock`)).toBe(false);
  } finally {
    chmodSync(parent, 0o700);
  }
});
