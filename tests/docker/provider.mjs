import { createServer } from "node:http";

// 只在验收 Compose 私有网络内运行的协议替身，绝不使用真实凭证。
createServer(async (request, response) => {
  if (request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let content = "";
  for await (const part of request) content += part;
  const input = JSON.parse(content);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.flushHeaders();
  const emit = (delta, finishReason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: "docker-test", choices: [{ index: 0, delta: { content: delta }, finish_reason: finishReason }] })}\n\n`,
    );
  emit("容器持久化测试回答");
  if (input.model === "hold") {
    const timer = setInterval(() => response.write(": heartbeat\n\n"), 1000);
    response.on("close", () => clearInterval(timer));
  } else {
    emit("", "stop");
    response.end("data: [DONE]\n\n");
  }
}).listen(8080, "0.0.0.0");
