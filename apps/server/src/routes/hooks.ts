/** Hook HTTP 管理：所有保存先预览准确版本再确认；查询不创建聊天，不向模型开放授权入口。 */

import type { HookService } from "@myagent/application";
import {
  AppError,
  type HookConfigSave,
  type McpConfigTarget,
} from "@myagent/contracts";
import type { FastifyInstance } from "fastify";

function target(value: unknown): McpConfigTarget {
  const v = value as Record<string, unknown> | null;
  if (
    !v ||
    !["user", "project"].includes(String(v.scope)) ||
    (v.scope === "project" && typeof v.workspaceId !== "string")
  )
    throw new AppError("invalid_target", "请选择用户级或项目级 Hook。");
  return {
    scope: v.scope as "user" | "project",
    ...(typeof v.workspaceId === "string"
      ? { workspaceId: v.workspaceId }
      : {}),
  };
}
export function registerHookRoutes(
  server: FastifyInstance,
  hooks: HookService,
): void {
  server.get("/api/v1/hooks/config", async (request) =>
    hooks.view(target(request.query)),
  );
  server.put("/api/v1/hooks/config", async (request) => {
    const value = request.body as HookConfigSave;
    const scope = target(value);
    if (
      typeof value.text !== "string" ||
      value.text.length > 262144 ||
      typeof value.expectedRevision !== "string" ||
      (value.expectedVersion !== undefined &&
        typeof value.expectedVersion !== "string")
    )
      throw new AppError("invalid_input", "请提交配置文本和预期版本。");
    return hooks.save({
      ...scope,
      text: value.text,
      expectedRevision: value.expectedRevision,
      ...(value.expectedVersion === undefined
        ? {}
        : { expectedVersion: value.expectedVersion }),
    });
  });
  server.post("/api/v1/hooks/confirm", async (request) => {
    const value = request.body as { revision: string; version: string };
    if (
      typeof value?.revision !== "string" ||
      typeof value?.version !== "string"
    )
      throw new AppError("invalid_input", "请提交预览中的准确版本。");
    return hooks.confirm(target(value), value.revision, value.version);
  });
  server.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/hooks",
    async (request) => hooks.records(request.params.id),
  );
}
