/** 项目管理路由：固定的目录窗口/目录浏览与项目准备入口，不允许调用方传入可执行脚本。 */

import type { McpManager, ProjectService } from "@myagent/application";
import { AppError } from "@myagent/contracts";
import type { FastifyInstance } from "fastify";
export function registerProjectRoutes(
  server: FastifyInstance,
  projects: ProjectService,
  mcp?: McpManager,
) {
  server.get("/api/v1/projects", async () => ({ projects: projects.list() }));
  server.post<{ Body: { path: string } }>(
    "/api/v1/projects/prepare",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4096 },
          },
        },
      },
    },
    async (request) => {
      const workspace = await projects.prepare(request.body.path);
      await mcp?.activate(workspace, false);
      return workspace;
    },
  );
  server.post("/api/v1/projects/pick", async (request) => {
    if (!request.headers.origin)
      throw new AppError("invalid_origin", "目录窗口只能从本机页面打开。", 403);
    return projects.directories.pick();
  });
  server.get<{ Querystring: { path?: string } }>(
    "/api/v1/projects/directories",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { path: { type: "string", maxLength: 4096 } },
        },
      },
    },
    async (request) => projects.directories.browse(request.query.path),
  );
}
