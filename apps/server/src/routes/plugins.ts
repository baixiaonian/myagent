/** 插件管理 HTTP 边界：限制本机管理请求，修改需要幂等标识和版本；确认不向模型暴露。 */
import type { PluginService } from "@myagent/application";
import {
  AppError,
  type McpConfigTarget,
  type PluginChange,
  type PluginConfirm,
  type PluginMutation,
} from "@myagent/contracts";
import type { FastifyInstance } from "fastify";

function target(raw: unknown): McpConfigTarget {
  const v = raw as McpConfigTarget;
  if (
    !v ||
    !["user", "project"].includes(v.scope) ||
    (v.scope === "project" && typeof v.workspaceId !== "string")
  )
    throw new AppError("invalid_target", "请选择插件作用域。");
  return v;
}
function request(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new AppError("invalid_input", "管理请求无效。");
  const v = raw as Record<string, unknown>;
  if (
    typeof v.requestId !== "string" ||
    !v.requestId ||
    v.requestId.length > 200
  )
    throw new AppError("invalid_input", "需要请求标识。");
  return v;
}
export function registerPluginRoutes(
  server: FastifyInstance,
  plugins: PluginService,
): void {
  server.get("/api/v1/plugins", async (req) => plugins.list(target(req.query)));
  server.get("/api/v1/plugins/jobs", async (req) =>
    plugins.jobs(target(req.query)),
  );
  server.post("/api/v1/plugins/preview", async (req) => {
    const v = request(req.body);
    target(v);
    if (
      !["install", "update", "configure", "rollback"].includes(
        String(v.action),
      ) ||
      !Number.isSafeInteger(v.expectedRevision) ||
      Number(v.expectedRevision) < 0 ||
      typeof v.enabled !== "boolean"
    )
      throw new AppError("invalid_input", "插件操作或版本无效。");
    if (v.source) {
      const s = v.source as Record<string, unknown>;
      if (
        !["local", "git"].includes(String(s.kind)) ||
        (s.kind === "local"
          ? typeof s.path !== "string"
          : typeof s.url !== "string") ||
        (s.ref !== undefined && typeof s.ref !== "string") ||
        (s.subdirectory !== undefined && typeof s.subdirectory !== "string")
      )
        throw new AppError("invalid_input", "插件来源无效。");
    }
    return plugins.preview(v as unknown as PluginMutation);
  });
  server.get<{ Params: { id: string } }>(
    "/api/v1/plugins/jobs/:id",
    async (req) => plugins.job(req.params.id),
  );
  server.post<{ Params: { id: string } }>(
    "/api/v1/plugins/jobs/:id/cancel",
    async (req) => {
      const value = request(req.body);
      return plugins.cancel(req.params.id, value.requestId as string);
    },
  );
  server.post<{ Params: { id: string } }>(
    "/api/v1/plugins/jobs/:id/confirm",
    async (req) => {
      const v = request(req.body);
      if (typeof v.confirmation !== "string")
        throw new AppError("invalid_input", "需要准确预览版本。");
      if (v.credentials) {
        if (typeof v.credentials !== "object" || Array.isArray(v.credentials))
          throw new AppError("invalid_input", "凭证格式无效。");
        for (const c of Object.values(v.credentials)) {
          const item = c as { token?: unknown; environment?: unknown };
          if (
            !item ||
            typeof item !== "object" ||
            (item.token !== undefined && typeof item.token !== "string") ||
            (item.environment !== undefined &&
              (!item.environment ||
                typeof item.environment !== "object" ||
                Array.isArray(item.environment) ||
                Object.values(item.environment).some(
                  (x) => typeof x !== "string",
                )))
          )
            throw new AppError("invalid_input", "凭证格式无效。");
        }
      }
      return plugins.confirm(req.params.id, v as unknown as PluginConfirm);
    },
  );
  server.post<{ Params: { id: string } }>(
    "/api/v1/plugins/:id/change",
    async (req) => {
      const v = request(req.body);
      target(v);
      if (
        !["disable", "uninstall", "inherit"].includes(String(v.action)) ||
        !Number.isSafeInteger(v.expectedRevision)
      )
        throw new AppError("invalid_input", "操作或版本无效。");
      return plugins.change(req.params.id, v as unknown as PluginChange);
    },
  );
}
