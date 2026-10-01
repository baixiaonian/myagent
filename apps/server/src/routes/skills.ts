/** 技能管理 HTTP 边界：只登记本地来源与启停，不提供任意文件写入、网络安装或脚本执行接口。 */
import type { SkillService } from "@myagent/application";
import type { SkillSourceInput } from "@myagent/contracts";
import type { FastifyInstance } from "fastify";

const str = { type: "string", minLength: 1, maxLength: 4096 };
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", additionalProperties: false, properties, required });
const params = object({ id: str }, ["id"]);
const query = object({ workspaceId: str });
export function registerSkillRoutes(
  server: FastifyInstance,
  skills: SkillService,
) {
  server.get<{ Querystring: { workspaceId?: string } }>(
    "/api/v1/skills",
    { schema: { querystring: query } },
    async (r) => skills.catalog(r.query.workspaceId, false),
  );
  server.post<{ Body: { workspaceId?: string } }>(
    "/api/v1/skills/refresh",
    { schema: { body: query } },
    async (r) => skills.catalog(r.body.workspaceId),
  );
  server.get<{ Params: { id: string }; Querystring: { workspaceId?: string } }>(
    "/api/v1/skills/:id",
    { schema: { params, querystring: query } },
    async (r) => skills.detail(r.params.id, r.query.workspaceId),
  );
  server.patch<{
    Params: { id: string };
    Body: { enabled: boolean; workspaceId?: string };
  }>(
    "/api/v1/skills/:id",
    {
      schema: {
        params,
        body: object({ enabled: { type: "boolean" }, workspaceId: str }, [
          "enabled",
        ]),
      },
    },
    async (r) => {
      skills.setEnabled(r.params.id, r.body.enabled, r.body.workspaceId);
      return { ok: true };
    },
  );
  server.get<{ Querystring: { workspaceId?: string } }>(
    "/api/v1/skill-sources",
    { schema: { querystring: query } },
    async (r) => ({ sources: skills.catalog(r.query.workspaceId).sources }),
  );
  server.post<{ Body: SkillSourceInput }>(
    "/api/v1/skill-sources",
    {
      schema: {
        body: object(
          { path: str, scope: { enum: ["user", "project"] }, workspaceId: str },
          ["path", "scope"],
        ),
      },
    },
    async (r) => skills.addSource(r.body),
  );
  server.patch<{
    Params: { id: string };
    Body: {
      enabled?: boolean;
      scope?: "user" | "project";
      workspaceId?: string;
      expectedRevision: number;
    };
  }>(
    "/api/v1/skill-sources/:id",
    {
      schema: {
        params,
        body: object(
          {
            enabled: { type: "boolean" },
            scope: { enum: ["user", "project"] },
            workspaceId: str,
            expectedRevision: { type: "integer", minimum: 0 },
          },
          ["expectedRevision"],
        ),
      },
    },
    async (r) => skills.changeSource(r.params.id, r.body),
  );
  server.delete<{ Params: { id: string } }>(
    "/api/v1/skill-sources/:id",
    { schema: { params } },
    async (r) => {
      skills.removeSource(r.params.id);
      return { ok: true };
    },
  );
}
