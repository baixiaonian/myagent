/**
 * 容器内协议替身：通过独立验收网络返回固定文字或持续挂起的流。
 * 仅供 Docker 持久化和 SIGKILL 恢复测试，不使用真实密钥或向宿主发布模型端口。
 */
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
  // 先返回可落盘文字，再持续保活且不结束，给容器 SIGKILL 留出确定的中断窗口。
  if (input.model === "hold") {
    const timer = setInterval(() => response.write(": heartbeat\n\n"), 1000);
    response.on("close", () => clearInterval(timer));
  } else {
    emit("", "stop");
    response.end("data: [DONE]\n\n");
  }
}).listen(8080, "0.0.0.0");
