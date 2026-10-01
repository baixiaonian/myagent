/** MCP 文件管理 HTTP 边界：所有保存/确认经应用层，公开读取只返回脱敏文档和真实连接状态。 */
import type { McpManager } from "@myagent/application";
import type {
  McpConfigConfirmation,
  McpConfigSave,
  McpConfigTarget,
} from "@myagent/contracts";
import type { FastifyInstance } from "fastify";

const target = {
  scope: { enum: ["user", "project"] },
  workspaceId: { type: "string", minLength: 1, maxLength: 200 },
};
export function registerMcpManagementRoutes(
  server: FastifyInstance,
  manager: McpManager,
) {
  server.get<{ Querystring: { workspaceId?: string } }>(
    "/api/v1/mcp/overview",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { workspaceId: target.workspaceId },
        },
      },
    },
    async (r) => manager.overview(r.query.workspaceId),
  );
  server.get<{ Querystring: McpConfigTarget }>(
    "/api/v1/mcp/config",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["scope"],
          properties: target,
        },
      },
    },
    async (r) => manager.config(r.query),
  );
  server.put<{ Body: McpConfigSave }>(
    "/api/v1/mcp/config",
    {
      bodyLimit: 262144,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["scope", "expectedRevision", "document"],
          properties: {
            ...target,
            expectedRevision: { type: "string", maxLength: 100 },
            document: { type: "object" },
            convertSecrets: { type: "boolean" },
          },
        },
      },
    },
    async (r) => manager.save(r.body),
  );
  server.post<{ Body: McpConfigConfirmation }>(
    "/api/v1/mcp/config/confirm",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["scope", "expectedRevision"],
          properties: {
            ...target,
            expectedRevision: { type: "string", maxLength: 100 },
            convertSecrets: { type: "boolean" },
          },
        },
      },
    },
    async (r) => manager.confirm(r.body),
  );
  server.post<{ Params: { id: string }; Body: { workspaceId: string } }>(
    "/api/v1/mcp/servers/:id/reconnect",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId"],
          properties: { workspaceId: target.workspaceId },
        },
      },
    },
    async (r) => manager.reconnect(r.params.id, r.body.workspaceId),
  );
}
