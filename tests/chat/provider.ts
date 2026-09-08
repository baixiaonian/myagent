import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
export interface CapturedRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  [key: string]: unknown;
}
/** 仅用于协议与浏览器验收，不代表真实模型能力。 */
export async function mockProvider(port = 0) {
  const requests: CapturedRequest[] = [];
  let cancelled = 0;
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const part of request) body += String(part);
    const input = JSON.parse(body) as CapturedRequest;
    requests.push(input);
    const question = input.messages.at(-1)?.content ?? "";
    const model = input.model;
    const status = { unauthorized: 401, missing: 404, limited: 429, bad: 400 }[
      model
    ];
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
          : `收到：${question}。这是第 ${input.messages.filter((m) => m.role === "user").length} 轮问答。`;
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
    chunks.forEach((content, index) => {
      schedule(
        () => {
          event({
            id: "mock",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          });
          if (model === "broken" && index === 0) response.end();
        },
        10 + index * delay,
      );
    });
    schedule(
      () => {
        event({
          id: "mock",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        response.end("data: [DONE]\n\n");
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
