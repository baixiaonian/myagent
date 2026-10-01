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
  const messages = responses ? input.input : input.messages;
  const question =
    messages.findLast(
      (m) =>
        m.role === "user" &&
        !String(m.content).startsWith("[团队消息") &&
        !String(m.content).startsWith("[创建成员时共享的背景资料"),
    )?.content ?? "";
  let text =
    input.model === "context" && question === "上下文长任务"
      ? "已经确认的历史事实。".repeat(3000)
      : input.model === "context"
        ? "历史已整理，保留原始记录，可以继续任务。"
        : "容器持久化测试回答";
  if (
    question.startsWith("[{") &&
    question.includes('"index"') &&
    question.includes('"createdAt"')
  )
    text = JSON.stringify({
      memories: [
        {
          title: "容器星舟日志",
          text: "日志存放于容器星舟目录。",
          kind: "project",
          projectSpecific: true,
          sourceIndexes: [0],
        },
      ],
    });
  if (question.startsWith('{"candidates":'))
    text = JSON.stringify({
      actions: JSON.parse(question).candidates.map((c) => ({
        ...c,
        action: "add",
      })),
    });
  const feedback = responses
    ? input.input.filter((i) => i.type === "function_call_output")
    : input.messages.filter((m) => m.role === "tool");
  let calls =
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
  if (input.model === "full-access") {
    calls = feedback.length
      ? []
      : [
          {
            id: "unrestricted-command",
            name: "exec_command",
            arguments: JSON.stringify({
              command: `printf FULL_ACCESS_CONTAINER > /workspaces/full-access-check.txt; cat /workspaces/full-access-check.txt; node -e 'fetch("http://127.0.0.1:3000/healthz").then(r=>r.text()).then(console.log)'`,
              yieldTimeMs: 1000,
            }),
          },
        ];
  }
  if (input.model === "teams") {
    const child = question === "容器成员任务";
    calls = feedback.length
      ? []
      : child
        ? [{ id: "member-time", name: "get_current_time", arguments: "{}" }]
        : [
            {
              id: "spawn",
              name: "spawn_agent",
              arguments: JSON.stringify({
                name: "容器成员",
                instructions: "核验时间",
                task: "容器成员任务",
              }),
            },
          ];
    text = child ? "成员完成核验" : "团队汇总完成";
  }
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
