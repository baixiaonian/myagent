/** 命令权限 HTTP 边界：本机设置操作，严格校验输入；测试入口仅分析，绝不启动命令。 */
import type { CommandPolicyService } from "@myagent/application";
import type {
  CommandConfigConfirmation,
  CommandConfigSave,
  CommandConfigTarget,
  CommandEvaluationInput,
} from "@myagent/contracts";
import { AppError } from "@myagent/contracts";
import type { ToolRegistryPort } from "@myagent/kernel";
import type { ExecutionStore } from "@myagent/state";
import type { FastifyInstance } from "fastify";

export function registerCommandPolicyRoutes(
  server: FastifyInstance,
  commands: CommandPolicyService,
  store: ExecutionStore,
  registry: ToolRegistryPort,
): void {
  const target = {
    scope: { type: "string", enum: ["user", "project"] },
    workspaceId: { type: "string", minLength: 1, maxLength: 100 },
  };
  const revision = { type: "string", minLength: 1, maxLength: 100 };
  server.get<{ Querystring: CommandConfigTarget }>(
    "/api/v1/command-policy/config",
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
    async (request) => commands.view(request.query),
  );
  server.put<{ Body: CommandConfigSave }>(
    "/api/v1/command-policy/config",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["scope", "expectedRevision", "text"],
          properties: {
            ...target,
            expectedRevision: revision,
            text: { type: "string", minLength: 1, maxLength: 60000 },
          },
        },
      },
    },
    async (request) => commands.save(request.body),
  );
  server.post<{ Body: CommandConfigConfirmation }>(
    "/api/v1/command-policy/config/confirm",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["scope", "expectedRevision"],
          properties: { ...target, expectedRevision: revision },
        },
      },
    },
    async (request) => commands.confirm(request.body),
  );
  server.post<{ Body: CommandEvaluationInput }>(
    "/api/v1/command-policy/evaluate",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "command"],
          properties: {
            workspaceId: target.workspaceId,
            command: { type: "string", minLength: 1, maxLength: 32000 },
            cwd: { type: "string", maxLength: 4000 },
          },
        },
      },
    },
    async (request) => {
      const workspace = store.get("workspaces", request.body.workspaceId);
      if (!workspace)
        throw new AppError("workspace_required", "请先选择项目。");
      const context = {
        sessionId: "preview",
        runId: "preview",
        stepId: "preview",
        invocationId: "preview",
        workspace,
      };
      const prepared = await registry.prepare(
        "exec_command",
        JSON.stringify({
          command: request.body.command,
          ...(request.body.cwd ? { cwd: request.body.cwd } : {}),
        }),
        context,
      );
      return commands.assess(prepared, context);
    },
  );
}
