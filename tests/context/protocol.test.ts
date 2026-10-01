/** 双协议真实 HTTP 验收：输入估算与实际请求体一致，Responses 不重复计算展示正文。 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import {
  OpenAIChatModel,
  OpenAIResponsesModel,
} from "../../packages/adapters/src/index.js";
import {
  estimateTokens,
  type ModelMessage,
} from "../../packages/kernel/src/index.js";
import { mockProvider } from "../chat/provider.js";

it.each(["responses", "chat_completions"] as const)(
  "%s 复用真实序列化估算且保留厂商续接",
  async (protocol) => {
    const provider = await mockProvider();
    try {
      const model =
        protocol === "responses"
          ? new OpenAIResponsesModel(provider.url, "fake", "test")
          : new OpenAIChatModel(provider.url, "fake", "test");
      const messages: ModelMessage[] = [
        { role: "user", content: "前一个问题" },
        {
          role: "assistant",
          content: "display".repeat(500),
          sourceId: "local-only",
          continuation:
            protocol === "responses"
              ? {
                  protocol,
                  items: [
                    {
                      type: "message",
                      role: "assistant",
                      content: [
                        { type: "output_text", text: "实际已保存的输出" },
                      ],
                    },
                  ],
                }
              : { protocol, reasoningContent: "私有续接" },
        },
        { role: "user", content: "你好" },
      ];
      const estimate = model.estimateInput(messages, []);
      for await (const _ of model.stream(
        messages,
        new AbortController().signal,
        [],
      )) {
        /* 必须消费完整流才能比较实际 HTTP 请求。 */
      }
      const request = { ...provider.requests[0] };
      if (protocol === "responses") delete request.messages;
      expect(estimate).toBe(estimateTokens(request));
      expect(JSON.stringify(request)).not.toContain("local-only");
      if (protocol === "responses") {
        expect(JSON.stringify(request)).not.toContain("display");
        expect(request.store).toBe(false);
        expect(request.previous_response_id).toBeUndefined();
      }
    } finally {
      await provider.close();
    }
  },
);

it.each(["http", "failed", "error"])(
  "Responses %s 容量错误映射一致，不自动重试或回显正文",
  async (mode) => {
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _ of request) {
        /* 消费本测试输入，响应只包含构造的错误。 */
      }
      requests++;
      if (mode === "http")
        response.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            error: {
              code: "context_length_exceeded",
              message: "private-fixture",
            },
          }),
        );
      else
        response
          .writeHead(200, { "Content-Type": "text/event-stream" })
          .end(
            `data: ${JSON.stringify(mode === "failed" ? { type: "response.failed", response: { status: "failed", error: { code: "context_length_exceeded", message: "private-fixture" } } } : { type: "error", code: "context_length_exceeded", message: "private-fixture" })}\n\n`,
          );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const model = new OpenAIResponsesModel(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        "fake",
        "test",
      );
      const consume = async () => {
        for await (const _ of model.stream(
          [{ role: "user", content: "你好" }],
          new AbortController().signal,
        )) {
          /* 消费错误流。 */
        }
      };
      await expect(consume()).rejects.toMatchObject({
        code: "provider_context_limit",
        message: expect.not.stringContaining("private-fixture"),
      });
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
