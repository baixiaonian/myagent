/**
 * MCP 连接与 OAuth 路由：配置写入保持严格 Schema，授权码只交给服务端适配器交换。
 * 回调响应不回显 code/state，页面不把 Token 保存到浏览器；原有 Host 检查继续生效。
 */
import type { McpRuntime } from "@myagent/adapters";
import type { McpManager, McpSettingsService } from "@myagent/application";
import type { McpConnectionInput } from "@myagent/contracts";
import type { FastifyInstance } from "fastify";

const text = { type: "string", maxLength: 4096 };
const connectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "transport", "workspaceIds", "auth"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    transport: { enum: ["stdio", "http"] },
    toolExposure: { enum: ["deferred", "direct"] },
    command: text,
    args: { type: "array", maxItems: 100, items: text },
    url: text,
    workspaceIds: { type: "array", maxItems: 100, items: text },
    auth: { enum: ["none", "token", "oauth"] },
    token: { type: "string", minLength: 1, maxLength: 8192 },
    environment: {
      type: "object",
      maxProperties: 50,
      additionalProperties: { type: "string", maxLength: 8192 },
    },
    clientId: text,
    clientMetadataUrl: text,
    networkDomains: { type: "array", maxItems: 20, items: text },
    additionalPaths: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "access"],
        properties: { path: text, access: { enum: ["read", "write"] } },
      },
    },
    expectedRevision: { type: "integer", minimum: 0 },
  },
};
export function registerMcpRoutes(
  server: FastifyInstance,
  settings: McpSettingsService,
  runtime: McpRuntime,
  manager?: McpManager,
): void {
  server.get("/api/v1/mcp/connections", async () => ({
    connections: settings.list(),
  }));
  server.post<{ Body: McpConnectionInput }>(
    "/api/v1/mcp/connections",
    { schema: { body: connectionSchema } },
    async (request) =>
      manager
        ? manager.saveConnection(request.body)
        : settings.save(request.body),
  );
  server.put<{ Params: { id: string }; Body: McpConnectionInput }>(
    "/api/v1/mcp/connections/:id",
    { schema: { body: connectionSchema } },
    async (request) =>
      manager
        ? manager.saveConnection(request.body, request.params.id)
        : settings.save(request.body, request.params.id),
  );
  server.post<{ Params: { id: string }; Body: { workspaceId: string } }>(
    "/api/v1/mcp/connections/:id/connect",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId"],
          properties: { workspaceId: text },
        },
      },
    },
    async (request) =>
      settings.connect(request.params.id, request.body.workspaceId),
  );
  server.delete<{ Params: { id: string } }>(
    "/api/v1/mcp/connections/:id",
    async (request) =>
      manager
        ? manager.removeConnection(request.params.id)
        : settings.remove(request.params.id),
  );
  server.get<{ Querystring: { state: string; code: string } }>(
    "/api/v1/mcp/oauth/callback",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["state", "code"],
          properties: {
            state: { type: "string", minLength: 1, maxLength: 1000 },
            code: { type: "string", minLength: 1, maxLength: 8192 },
          },
        },
      },
    },
    async (request, reply) => {
      await runtime.finishAuth(request.query.state, request.query.code);
      return reply
        .header(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'",
        )
        .type("text/html")
        .send(
          '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MCP 已连接</title><body><h1>MCP 授权完成</h1><p>可以关闭此页面，返回 MyAgent 继续使用。</p></body></html>',
        );
    },
  );
}
