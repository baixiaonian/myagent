/**
 * Docker 验收专用双协议服务：固定文本、工具批次与挂起流，用于验证镜像内的真实执行和恢复。
 * 只在独立 Compose 网络中服务，不使用用户密钥，不代表真实模型能力。
 */
import { createServer } from "node:http";

createServer(async (request, response) => {
  const responses = request.url === "/v1/responses";
  if (!responses && request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let content = "";
  for await (const part of request) content += part;
  const input = JSON.parse(content);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.flushHeaders();
  const event = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  const text = "容器持久化测试回答";
  const feedback = responses
    ? input.input.filter((i) => i.type === "function_call_output")
    : input.messages.filter((m) => m.role === "tool");
  const calls =
    input.model === "agent" && !feedback.length
      ? [
          {
            id: "plan",
            name: "update_plan",
            arguments: JSON.stringify({
              steps: [{ description: "查询时间", status: "in_progress" }],
            }),
          },
          { id: "time", name: "get_current_time", arguments: "{}" },
        ]
      : [];
  if (responses) {
    event({ type: "response.output_text.delta", delta: text });
    if (input.model !== "hold") {
      event({
        type: "response.completed",
        response: {
          id: "docker",
          object: "response",
          status: "completed",
          model: input.model,
          output: [
            {
              type: "message",
              id: "m",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            },
            ...calls.map((c) => ({
              type: "function_call",
              id: c.id,
              call_id: c.id,
              name: c.name,
              arguments: c.arguments,
              status: "completed",
            })),
          ],
          usage: null,
        },
      });
      response.end();
    }
  } else {
    event({
      choices: [
        {
          index: 0,
          delta: {
            content: text,
            ...(calls.length
              ? {
                  tool_calls: calls.map((c, index) => ({
                    index,
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: c.arguments },
                  })),
                }
              : {}),
          },
          finish_reason: null,
        },
      ],
    });
    if (input.model !== "hold") {
      event({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: calls.length ? "tool_calls" : "stop",
          },
        ],
      });
      response.end("data: [DONE]\n\n");
    }
  }
  if (input.model === "hold") {
    const timer = setInterval(() => response.write(": heartbeat\n\n"), 1000);
    response.on("close", () => clearInterval(timer));
  }
}).listen(8080, "0.0.0.0");
