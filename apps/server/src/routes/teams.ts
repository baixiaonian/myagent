/** 团队 HTTP 管理边界：用户通过主会话查看成员，不提供直接给成员发起付费任务的接口。 */
import type { TeamService } from "@myagent/application";
import type { TeamStopInput } from "@myagent/contracts";
import type { FastifyInstance } from "fastify";

const string = { type: "string", minLength: 1, maxLength: 200 };
const params = {
  type: "object",
  additionalProperties: false,
  properties: { id: string, agentId: string },
  required: ["id"],
};
const query = {
  type: "object",
  additionalProperties: false,
  properties: { cursor: { type: "string", maxLength: 100 } },
};
export function registerTeamRoutes(
  server: FastifyInstance,
  teams: TeamService,
) {
  server.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/team",
    { schema: { params } },
    async (r) => teams.view(r.params.id),
  );
  server.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    "/api/v1/sessions/:id/team/messages",
    { schema: { params, querystring: query } },
    async (r) => teams.messages(r.params.id, r.query.cursor),
  );
  server.get<{
    Params: { id: string; agentId: string };
    Querystring: { cursor?: string };
  }>(
    "/api/v1/sessions/:id/agents/:agentId/history",
    { schema: { params, querystring: query } },
    async (r) => teams.history(r.params.id, r.params.agentId, r.query.cursor),
  );
  server.post<{ Params: { id: string; agentId: string }; Body: TeamStopInput }>(
    "/api/v1/sessions/:id/agents/:agentId/stop",
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            requestId: string,
            expectedRevision: { type: "integer", minimum: 0 },
            close: { type: "boolean" },
          },
          required: ["requestId", "expectedRevision"],
        },
      },
    },
    async (r) => teams.stop(r.params.id, r.params.agentId, r.body),
  );
}
