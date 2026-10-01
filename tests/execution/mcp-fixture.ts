/**
 * MCP/OAuth 本地协议服务替身：真实 HTTP 收发，记录调用次数以验证取消与鉴权失败不重放。
 * 所有 Token 均为测试值，不访问任何真实账号或外部服务。
 */
import { createServer } from "node:http";
export async function mcpFixture(
  options: { oauth?: boolean; token?: string; toolCount?: number } = {},
) {
  let origin = "";
  let token = options.token ?? "mcp-fixture-access";
  let rejectCalls = false;
  let description = "回显文字";
  const calls: unknown[] = [];
  const exchanges: URLSearchParams[] = [];
  let initializeCount = 0;
  let revocations = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin || "http://localhost");
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname.includes(".well-known/oauth-protected-resource"))
      return json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["tools"],
      });
    if (
      url.pathname.includes(".well-known/oauth-authorization-server") ||
      url.pathname.includes(".well-known/openid-configuration")
    )
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        revocation_endpoint: `${origin}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register")
      return json(
        { ...JSON.parse(body), client_id: "myagent-fixture-client" },
        201,
      );
    if (url.pathname === "/token") {
      exchanges.push(new URLSearchParams(body));
      return json({
        access_token: token,
        token_type: "Bearer",
        refresh_token: "mcp-fixture-refresh",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/revoke") {
      revocations++;
      return json({});
    }
    if (url.pathname === "/authorize") {
      const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      callback.searchParams.set("code", "fixture-code");
      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }
    if (url.pathname !== "/mcp") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405);
      response.end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(204);
      response.end();
      return;
    }
    const message = JSON.parse(body || "{}") as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string; arguments?: { text?: string } };
    };
    if (message.method === "tools/call") calls.push(message);
    if (
      ((options.oauth || options.token) &&
        request.headers.authorization !== `Bearer ${token}`) ||
      (rejectCalls && message.method === "tools/call")
    ) {
      response.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      });
      response.end();
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const reply = (result: unknown) =>
      json({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") {
      initializeCount++;
      reply({
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      });
      return;
    }
    if (message.method === "tools/list") {
      reply({
        // 多工具目录用于验证直接提供不受搜索分页上限影响；默认仍保持原单工具协议。
        tools: Array.from({ length: options.toolCount ?? 1 }, (_, index) => ({
          name: options.toolCount ? `echo_${index}` : "echo",
          description,
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        })),
      });
      return;
    }
    if (message.method === "tools/call") {
      const text = message.params?.arguments?.text ?? "";
      if (text === "hang") return;
      reply({
        isError: text === "fail",
        content: [
          {
            type: "text",
            text:
              text === "secret"
                ? token
                : text === "large"
                  ? "中文回声".repeat(4000)
                  : text,
          },
        ],
      });
      return;
    }
    json({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Unsupported" },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    calls,
    exchanges,
    get revocations() {
      return revocations;
    },
    get initializeCount() {
      return initializeCount;
    },
    setToken(value: string) {
      token = value;
    },
    /** 重连重新发现后生成不同定义版本，用于验证旧选择不能悄悄套用新 Schema/说明。 */
    setDescription(value: string) {
      description = value;
    },
    rejectToolCalls() {
      rejectCalls = true;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
