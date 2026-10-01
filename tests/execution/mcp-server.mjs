/**
 * 原生 stdio MCP 测试程序：只读标准输入并回显测试参数，不访问真实网络或用户目录。
 * 用于验证 SDK 分帧、沙箱启动、独立环境和取消后的进程清理。
 */
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const send = (result) =>
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`,
    );
  if (message.method === "initialize")
    send({
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "stdio-fixture", version: "1" },
    });
  else if (message.method === "tools/list")
    send({
      tools: [
        {
          name: "echo",
          description: "stdio 回显",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      ],
    });
  else if (message.method === "tools/call")
    send({
      content: [
        {
          type: "text",
          text:
            message.params.arguments.text === "secret"
              ? process.env.MCP_FIXTURE_TOKEN
              : message.params.arguments.text,
        },
      ],
    });
  else
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported" } })}\n`,
    );
});
