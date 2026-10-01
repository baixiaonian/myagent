/**
 * OpenAI 兼容协议替身：监听 loopback，记录请求并返回可控文字分片、错误或挂起流。
 * 只使用测试密钥；用于检验真实 HTTP 传输和客户端行为，不模拟模型推理质量。
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
export interface CapturedRequest {
  model: string;
  messages: {
    role: string;
    content: string;
    tool_call_id?: string;
    tool_calls?: unknown[];
    reasoning_content?: string;
  }[];
  input?: Record<string, unknown>[];
  stream: boolean;
  [key: string]: unknown;
}
/** 背景资料也是 user 角色，但不能算作用户新问题或把工具批次归入错误轮次。 */
function userQuestion(message: { role: string; content: string }): boolean {
  return (
    message.role === "user" &&
    ![
      "可用技能目录：",
      "使用 search_skills",
      "[本轮技能说明",
      "[历史资料摘要",
      "[执行状态更新",
      "[团队消息",
      "[创建成员时共享的背景资料",
    ].some((prefix) => message.content.startsWith(prefix))
  );
}
/** 仅用于协议与浏览器验收，不代表真实模型能力。 */
export async function mockProvider(
  port = 0,
  toolScenario?: (
    question: string,
    results: { content: string }[],
    definitions: unknown,
  ) => {
    calls: { id: string; name: string; arguments: string }[];
    text: string;
  } | null,
) {
  const requests: CapturedRequest[] = [];
  let cancelled = 0;
  const server = createServer(async (request, response) => {
    const responses = request.url === "/v1/responses";
    if (request.url !== "/v1/chat/completions" && !responses) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const part of request) body += String(part);
    const input = JSON.parse(body) as CapturedRequest;
    if (responses)
      input.messages = (input.input ?? [])
        .filter((item) => item.type !== "reasoning")
        .map((item) => ({
          role:
            item.type === "function_call_output"
              ? "tool"
              : String(item.role ?? "assistant"),
          content:
            typeof item.content === "string"
              ? item.content
              : typeof item.output === "string"
                ? item.output
                : Array.isArray(item.content)
                  ? item.content
                      .map((part) => (part as { text?: string }).text ?? "")
                      .join("")
                  : "",
        }));
    requests.push(input);
    const question = input.messages.findLast(userQuestion)?.content ?? "";
    const model = input.model;
    // 通过模型名选择固定失败场景；故意在上游错误中回显假鉴权信息，检验应用是否正确脱敏。
    const status = {
      unauthorized: 401,
      payment: 402,
      missing: 404,
      limited: 429,
      bad: 400,
    }[model];
    if (status) {
      response.writeHead(status, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          error: {
            message: `Secret echoed ${request.headers.authorization}`,
            type: "provider_error",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
    let closed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    response.on("close", () => {
      closed = true;
      if (!response.writableEnded) cancelled++;
      for (const timer of timers) clearTimeout(timer);
    });
    const schedule = (callback: () => void, delay: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closed) callback();
      }, delay);
      timers.add(timer);
    };
    // 挂起模式不返回终态，用于验证超时和取消；连接关闭事件负责清理所有调度定时器。
    if (model === "hang") return;
    const markdown =
      "**这是一条测试回答**\n\n| 项目 | 内容 |\n| --- | --- |\n| 模式 | 本地测试 |\n\n```js\nconst hello = '你好';\nconsole.log(hello);\n```\n\n<script>window.injected = true</script>\n<img src=x onerror=alert(1)>\n[jump](javascript:alert(1))\n";
    const markdownContent = question.includes("长文")
      ? markdown.repeat(12)
      : markdown;
    const text =
      question === "Reply with OK."
        ? "OK"
        : question.includes("Markdown")
          ? markdownContent
          : `收到：${question}。这是第 ${input.messages.filter(userQuestion).length} 轮问答。`;
    const chunks = Array.from(text.match(/.{1,8}|\n/gs) ?? []);
    const slow = model === "slow" || question.includes("慢速");
    const delay = slow ? 180 : 3;
    const event = (data: unknown) => {
      // 刻意拆开 UTF-8 数据，验证 SDK 能处理 HTTP 分片。
      const bytes = Buffer.from(`data: ${JSON.stringify(data)}\n\n`);
      const middle = Math.floor(bytes.length / 2);
      response.write(bytes.subarray(0, middle));
      response.write(bytes.subarray(middle));
    };
    const responseObject = (output: unknown[], status = "completed") => ({
      id: "resp_mock",
      object: "response",
      created_at: 1,
      model,
      status,
      output,
      usage: null,
    });
    const messageItem = (value: string) => ({
      type: "message",
      id: "msg_mock",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: value, annotations: [] }],
    });
    const lastQuestion = input.messages.findLastIndex(userQuestion);
    const scenario = toolScenario?.(
      question,
      input.messages
        .slice(lastQuestion + 1)
        .filter((message) => message.role === "tool"),
      input.tools,
    );
    if ((question.includes("Agent") || scenario) && (input.tools || scenario)) {
      // 三次模型请求：先计划和取时间，再修改计划，最后回答；测试控制器不模拟真实推理。
      const lastUser = input.messages.findLastIndex(userQuestion);
      const results = input.messages
        .slice(lastUser + 1)
        .filter((m) => m.role === "tool");
      const calls =
        scenario?.calls ??
        (results.length === 0
          ? [
              {
                id: "plan1",
                name: "update_plan",
                arguments: JSON.stringify({
                  steps: [
                    { description: "查询时间", status: "in_progress" },
                    { description: "给出回答", status: "pending" },
                  ],
                }),
              },
              {
                id: "time1",
                name: "get_current_time",
                arguments: JSON.stringify({ timezone: "Asia/Shanghai" }),
              },
            ]
          : results.length === 2
            ? [
                {
                  id: "plan2",
                  name: "update_plan",
                  arguments: JSON.stringify({
                    steps: [
                      { description: "查询时间", status: "completed" },
                      { description: "给出回答", status: "completed" },
                    ],
                    explanation: "已获得真实工具结果",
                  }),
                },
              ]
            : []);
      const text =
        scenario?.text ??
        (calls.length
          ? "正在处理任务。"
          : "Agent 任务已完成，已查询时间并更新计划。");
      schedule(
        () => {
          if (responses) {
            event({ type: "response.output_text.delta", delta: text });
            for (const call of calls)
              for (const delta of [
                call.arguments.slice(0, 3),
                call.arguments.slice(3),
              ])
                event({
                  type: "response.function_call_arguments.delta",
                  delta,
                  item_id: `item_${call.id}`,
                  output_index: 1,
                });
            const output = [
              {
                type: "reasoning",
                id: `reason_${results.length}`,
                content: [
                  { type: "reasoning_text", text: "private-reasoning-fixture" },
                ],
                summary: [],
              },
              messageItem(text),
              ...calls.map((call) => ({
                type: "function_call",
                id: `item_${call.id}`,
                call_id: call.id,
                name: call.name,
                arguments: call.arguments,
                status: "completed",
              })),
            ];
            event({
              type: "response.completed",
              response: responseObject(output),
            });
            response.end();
          } else {
            event({
              choices: [
                {
                  index: 0,
                  delta: {
                    content: text,
                    reasoning_content: "private-reasoning-fixture",
                  },
                  finish_reason: null,
                },
              ],
            });
            calls.forEach((call, index) => {
              event({
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index,
                          id: call.id,
                          type: "function",
                          function: {
                            name: call.name,
                            arguments: call.arguments.slice(0, 3),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
              event({
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index,
                          function: { arguments: call.arguments.slice(3) },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            });
            event({
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: calls.length ? "tool_calls" : "stop",
                },
              ],
            });
            response.end(responses ? undefined : "data: [DONE]\n\n");
          }
        },
        slow ? 500 : 10,
      );
      return;
    }
    chunks.forEach((content, index) => {
      schedule(
        () => {
          event(
            responses
              ? { type: "response.output_text.delta", delta: content }
              : {
                  id: "mock",
                  object: "chat.completion.chunk",
                  choices: [
                    { index: 0, delta: { content }, finish_reason: null },
                  ],
                },
          );
          // 只发一个文字块便结束 HTTP，故意缺失 finish_reason，让适配器必须报告不完整流。
          if (model === "broken" && index === 0) response.end();
        },
        10 + index * delay,
      );
    });
    schedule(
      () => {
        event(
          responses
            ? {
                type: "response.completed",
                response: responseObject([messageItem(text)]),
              }
            : {
                id: "mock",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
        );
        response.end(responses ? undefined : "data: [DONE]\n\n");
      },
      20 + chunks.length * delay,
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    get cancelled() {
      return cancelled;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
