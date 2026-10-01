/**
 * 工具系统 HTTP 路由：只做严格输入校验和用例委托，审批/恢复均保留服务端状态判断。
 * 完整结果按会话和随机引用访问，没有接受任意本机路径的下载端点。
 */
import type { ChatService, ToolService } from "@myagent/application";
import {
  type ApprovalDecision,
  isActiveRun,
  type ToolInvocation,
} from "@myagent/contracts";
import type { FastifyInstance } from "fastify";

const text = { type: "string", minLength: 1, maxLength: 4096 };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const version = { type: "integer", minimum: 0 };
export function registerExecutionRoutes(
  server: FastifyInstance,
  tools: ToolService,
  chat: ChatService,
): void {
  server.get("/api/v1/workspaces", async () => ({
    workspaces: tools.options.store.list("workspaces"),
  }));
  server.post<{ Body: { path: string; name: string } }>(
    "/api/v1/workspaces",
    {
      schema: {
        body: object({ path: text, name: { type: "string", maxLength: 100 } }),
      },
    },
    async (request) =>
      tools.createWorkspace(request.body.path, request.body.name),
  );
  server.put<{
    Params: { id: string };
    Body: { workspaceId: string; expectedRevision: number };
  }>(
    "/api/v1/sessions/:id/workspace",
    {
      schema: {
        body: object({ workspaceId: text, expectedRevision: version }),
      },
    },
    async (request) => {
      tools.options.store.bindWorkspace(
        request.params.id,
        request.body.workspaceId,
        request.body.expectedRevision,
      );
      return tools.options.chat.snapshot(request.params.id);
    },
  );
  server.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/execution",
    async (request) => tools.overview(request.params.id),
  );
  server.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/grants",
    async (request) => ({
      grants: tools.options.store
        .list("grants")
        .filter((grant) => grant.workspaceId === request.params.id),
    }),
  );
  server.delete<{ Params: { id: string } }>(
    "/api/v1/grants/:id",
    async (request, reply) => {
      await tools.revokeGrant(request.params.id);
      reply.status(204).send();
    },
  );
  server.post<{ Params: { id: string }; Body: ApprovalDecision }>(
    "/api/v1/approvals/:id/decision",
    {
      schema: {
        body: object({
          requestId: text,
          decision: { enum: ["allow", "deny"] },
          scope: { enum: ["once", "session", "workspace"] },
        }),
      },
    },
    async (request) => {
      const approval = tools.decide(request.params.id, request.body);
      // 当前进程仍在收拢同批操作时不启动第二个循环；resume 的 active 检查负责幂等。
      if (
        (approval.status === "approved" || approval.status === "denied") &&
        isActiveRun(tools.options.chat.getRun(approval.runId).status) &&
        !tools.options.store
          .list("approvals", { runId: approval.runId })
          .some((item) => item.status === "pending")
      )
        await chat.resume(approval.runId);
      return approval;
    },
  );
  server.post<{ Params: { id: string } }>(
    "/api/v1/runs/:id/resume",
    {
      schema: {
        body: object(
          {
            requestId: { type: "string", minLength: 1, maxLength: 200 },
            contextAction: { enum: ["retry", "apply_capacity"] },
          },
          [],
        ),
      },
    },
    async (request) =>
      chat.resume(
        request.params.id,
        request.body as import("@myagent/contracts").ContextResumeInput,
      ),
  );
  server.post<{
    Params: { id: string };
    Body: {
      kind: NonNullable<ToolInvocation["resolution"]>["kind"];
      note: string;
    };
  }>(
    "/api/v1/invocations/:id/resolve",
    {
      schema: {
        body: object({
          kind: {
            enum: [
              "acknowledged_unknown",
              "confirmed_executed",
              "confirmed_not_executed",
            ],
          },
          note: { type: "string", minLength: 1, maxLength: 2000 },
        }),
      },
    },
    async (request) =>
      tools.resolveUnknown(request.params.id, {
        ...request.body,
        at: new Date().toISOString(),
      }),
  );
  server.get<{
    Params: { id: string; resultId: string };
    Querystring: { cursor?: string };
  }>("/api/v1/sessions/:id/results/:resultId", async (request) =>
    tools.options.results.read(
      request.params.resultId,
      request.params.id,
      request.query.cursor,
    ),
  );
}
