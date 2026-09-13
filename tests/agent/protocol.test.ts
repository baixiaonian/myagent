/**
 * 模型协议故障注入：通过真实 HTTP SSE 喂给官方 SDK，验证不完整调用永远到不了工具执行器。
 * 同时检查 Responses 加密续接和两种协议的实际 usage；所有数据均为本文件构造的假数据。
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import {
  OpenAIChatModel,
  OpenAIResponsesModel,
} from "../../packages/adapters/src/index.js";
import type { ApiProtocol } from "../../packages/contracts/src/index.js";
import { runAgent } from "../../packages/kernel/src/index.js";

const protocols: ApiProtocol[] = ["responses", "chat_completions"];
const faults = [
  "truncated",
  "duplicate_id",
  "missing_id",
  "partial",
  "late_output",
];

it.each(
  protocols.flatMap((protocol) =>
    faults.map((fault) => [protocol, fault] as const),
  ),
)("%s rejects %s before executing any tool", async (protocol, fault) => {
  let executed = 0;
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      /* 读完请求再发送受控协议故障。 */
    }
    requests++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (data: unknown) =>
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    const call = {
      id: fault === "missing_id" ? "" : "call",
      name: "get_current_time",
      arguments: "{}",
    };
    if (protocol === "responses") {
      const item = {
        type: "function_call",
        id: "item",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
        status: fault === "partial" ? "in_progress" : "completed",
      };
      emit({
        type:
          fault === "truncated" ? "response.incomplete" : "response.completed",
        response: {
          status: fault === "truncated" ? "incomplete" : "completed",
          output:
            fault === "duplicate_id"
              ? [item, { ...item, id: "item2" }]
              : [item],
          usage: null,
        },
      });
      if (fault === "late_output")
        emit({ type: "response.function_call_arguments.delta", delta: "late" });
    } else {
      const tool = {
        ...(fault === "partial" ? {} : { index: 0 }),
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      };
      emit({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls:
                fault === "duplicate_id"
                  ? [tool, { ...tool, index: 1 }]
                  : [tool],
            },
            finish_reason: null,
          },
        ],
      });
      emit({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: fault === "truncated" ? "length" : "tool_calls",
          },
        ],
      });
      if (fault === "late_output")
        emit({
          choices: [
            { index: 0, delta: { content: "late" }, finish_reason: null },
          ],
        });
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const model =
      protocol === "responses"
        ? new OpenAIResponsesModel(base, "fixture", "fixture")
        : new OpenAIChatModel(base, "fixture", "fixture");
    await expect(
      runAgent({
        runId: "fault",
        current: [{ role: "user", content: "查询时间" }],
        model,
        tools: {
          definitions: [],
          async execute() {
            executed++;
            return null;
          },
        },
        signal: new AbortController().signal,
        onEvent() {},
      }),
    ).rejects.toMatchObject({
      code:
        fault === "truncated" ||
        (protocol === "responses" && fault === "partial")
          ? "model_incomplete"
          : "model_protocol",
    });
    expect(executed).toBe(0);
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

it.each(protocols)(
  "%s preserves actual usage and private reasoning continuation",
  async (protocol) => {
    const server = createServer(async (request, response) => {
      for await (const _ of request) {
        /* 本例只测试输出协议，输入由独立集成测试断言。 */
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (data: unknown) =>
        response.write(`data: ${JSON.stringify(data)}\n\n`);
      if (protocol === "responses") {
        emit({ type: "response.output_text.delta", delta: "答案" });
        emit({
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "reasoning",
                id: "r",
                summary: [],
                encrypted_content: "encrypted-fixture",
              },
              {
                type: "message",
                id: "m",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: "答案", annotations: [] },
                ],
              },
            ],
            usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
          },
        });
      } else {
        emit({
          choices: [
            {
              index: 0,
              delta: { content: "答案", reasoning_content: "private-fixture" },
              finish_reason: "stop",
            },
          ],
        });
        // 合法 usage 独立尾帧没有 choices，不能被误判为终态后的新输出。
        emit({
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        });
      }
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const model =
        protocol === "responses"
          ? new OpenAIResponsesModel(base, "fixture", "fixture")
          : new OpenAIChatModel(base, "fixture", "fixture");
      const events = [];
      for await (const event of model.stream(
        [{ role: "user", content: "问题" }],
        new AbortController().signal,
      ))
        events.push(event);
      const done = events.find((e) => e.type === "done");
      expect(done?.usage).toEqual({
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
      });
      expect(JSON.stringify(done?.response?.continuation)).toContain(
        protocol === "responses" ? "encrypted-fixture" : "private-fixture",
      );
      expect(done?.response?.content).toBe("答案");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  },
);
