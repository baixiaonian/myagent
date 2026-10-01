/** 观测协议验收：真实 loopback HTTP 与官方 SDK，对比网络端正文和保护文件；不代表真实模型能力。 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import type { ApiProtocol } from "../../packages/contracts/src/index.js";

const usage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  cacheReadTokens: 30,
  reasoningTokens: 10,
};
/** 输出故意跨中文 UTF-8 字节分片，含 SSE 注释与私有续接，采集层不能重建或删改。 */
function output(protocol: ApiProtocol) {
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
  if (protocol === "responses")
    return (
      ": 原始注释\r\n\r\n" +
      data({ type: "response.output_text.delta", delta: "你好" }) +
      data({
        type: "response.completed",
        response: {
          id: "resp_actual",
          model: "test",
          status: "completed",
          service_tier: "default",
          output: [
            {
              type: "reasoning",
              id: "private",
              encrypted_content: "private-encrypted-value",
              summary: [],
            },
            {
              type: "message",
              id: "msg",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "你好", annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: 30 },
            output_tokens_details: { reasoning_tokens: 10 },
          },
        },
      })
    );
  return (
    ": 原始注释\r\n\r\n" +
    data({
      id: "chat_actual",
      model: "test",
      service_tier: "default",
      choices: [
        {
          index: 0,
          delta: {
            content: "你好",
            reasoning_content: "private-reasoning-value",
          },
          finish_reason: null,
        },
      ],
    }) +
    data({
      id: "chat_actual",
      model: "test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) +
    data({
      id: "chat_actual",
      model: "test",
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    }) +
    "data: [DONE]\r\n\r\n"
  );
}

it.each(["responses", "chat_completions"] as const)(
  "%s records actual bodies, usage, switch snapshots and private boundaries",
  async (protocol) => {
    const dir = mkdtempSync(join(tmpdir(), "myagent-trace-http-"));
    const received: Buffer[] = [],
      sent: Buffer[] = [];
    let hold: (() => void) | undefined;
    let paused = false;
    const http = createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      received.push(Buffer.concat(parts));
      if (paused)
        await new Promise<void>((resolve) => {
          hold = resolve;
        });
      const bytes = Buffer.from(output(protocol));
      sent.push(bytes);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-request-id": "safe-provider-id",
        "set-cookie": "NEVER-STORE-COOKIE",
      });
      // 两个连续写入可能被 TCP 合并，但任意合并/分片均必须保留同一字节序列。
      for (let i = 0; i < bytes.length; i += 17)
        res.write(bytes.subarray(i, i + 17));
      await new Promise((resolve) => setTimeout(resolve, 40));
      res.end();
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const app = await buildServer({ dataDir: dir, serveWeb: false });
    try {
      app.settings.save({
        apiProtocol: protocol,
        baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
        model: "test",
        apiKey: "NEVER-STORE-AUTH-HEADER",
        systemPrompt: "系统正文原样保留",
        expectedRevision: 0,
      });
      const run = async () => {
        const lifecycle = new AbortController();
        for await (const _ of app.settings.model().model.stream(
          [{ role: "user", content: "中文问题\n含空白" }],
          lifecycle.signal,
          [
            {
              name: "fixture",
              description: "完整定义",
              parameters: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          ],
          { purpose: "connection_test" },
        )) {
          /* 消费模型流，正文不经聊天投影。 */
        }
        lifecycle.abort();
      };
      await run();
      expect(app.observations.store.list("captures")).toHaveLength(0);
      app.observations.configure({
        requestId: randomUUID(),
        expectedRevision: 0,
        debug: true,
        retentionDays: 30,
      });
      paused = true;
      const pending = run();
      await expect.poll(() => received.length).toBe(2);
      app.observations.configure({
        requestId: randomUUID(),
        expectedRevision: 1,
        debug: false,
        retentionDays: 30,
      });
      hold!();
      await pending;
      await expect
        .poll(
          () =>
            app.observations.store
              .list("captures")
              .filter((c) => c.status !== "capturing").length,
        )
        .toBe(2);
      const call = app.observations.calls().find((c) => c.debug)!;
      expect(call.usage).toEqual(usage);
      expect(call.sent).toBe(true);
      expect(call.status).toBe("succeeded");
      const captures = app.observations.call(call.id).captures;
      for (const capture of captures) {
        const bytes = Buffer.from(
          await app.observations.raw(call.id, capture.id),
        );
        expect(bytes).toEqual(
          capture.direction === "input" ? received[1] : sent[1],
        );
        expect(capture.status).toBe("complete");
        expect(capture.sha256).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        expect(bytes.toString()).not.toContain("NEVER-STORE-");
        const reply = await app.server.inject({
          method: "GET",
          url: `/api/v1/observability/calls/${call.id}/captures/${capture.id}?download=1`,
        });
        expect(reply.statusCode).toBe(200);
        expect(reply.rawPayload).toEqual(bytes);
        expect(reply.headers["cache-control"]).toBe("no-store");
      }
      const timeline = app.observations.trace(call.traceId);
      expect(JSON.stringify(timeline)).not.toContain("private-");
      expect(
        timeline.spans.find((s) => s.id === call.spanId)?.attributes[
          "gen_ai.usage.input_tokens"
        ],
      ).toBe(100);
      expect(app.observations.usage().total).toMatchObject({
        requests: 2,
        inputTokens: 200,
        outputTokens: 40,
        unknownUsage: 0,
        unpricedRequests: 2,
      });
      expect(app.observations.traces().items.every((t) => t.endedAt)).toBe(
        true,
      );
      const capture = captures[0]!;
      expect(
        (
          await app.server.inject({
            method: "GET",
            url: `/api/v1/observability/calls/not-the-call/captures/${capture.id}`,
          })
        ).statusCode,
      ).toBe(404);
      const clear = { requestId: randomUUID(), expectedRevision: 2 };
      await app.observations.clearCapture(call.id, capture.id, clear);
      await app.observations.clearCapture(call.id, capture.id, clear);
      await expect(
        app.observations.raw(call.id, capture.id),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      hold?.();
      await app.server.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20000,
);
