/**
 * 后端唯一组合根：装配 SQLite、凭证、模型工厂和应用服务，提供 HTTP / SSE 与 Web 静态资源。
 * 本文件拥有进程锁及服务生命周期；路由负责边界校验，生成语义交给 ChatService。
 * 日志和错误响应必须脱敏；浏览器断连只结束订阅，不终止后台 Run。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import staticPlugin from "@fastify/static";
import {
  FileCredentialStore,
  OpenAIChatModel,
  SqliteChatStore,
} from "@myagent/adapters";
import {
  ChatService,
  type ModelFactory,
  SettingsService,
} from "@myagent/application";
import {
  AppError,
  type RegenerateInput,
  type RunInput,
  type SettingsInput,
} from "@myagent/contracts";
import Fastify, { LogController } from "fastify";
import lockfile from "proper-lockfile";
import {
  regenerateSchema,
  renameSchema,
  runSchema,
  settingsSchema,
} from "../routes/schemas.js";

// 禁用 Fastify 默认逐请求日志，避免自动记录可能包含敏感参数的 URL。
class LocalLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
export interface ServerOptions {
  dataDir: string;
  serveWeb?: boolean;
  logger?: boolean;
  logSink?: { write(message: string): void };
  devOrigin?: string;
  modelFactory?: ModelFactory;
  timeoutMs?: number;
}
// 依次申请数据目录锁、数据库和凭证资源；初始化失败时释放已经拿到的资源。
// 所有具体适配器在此实例化，上层用例接收契约和工厂而不感知驱动。
export async function buildServer(options: ServerOptions) {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  // 兼容旧版本的目录旁锁；升级前必须先停止旧实例。
  if (await lockfile.check(options.dataDir, { stale: 10000 })) {
    throw new AppError("data_in_use", "数据目录正由另一个实例使用。", 503);
  }
  // 锁放在可写数据卷内部，以支持父目录只读的普通用户容器；不依赖父目录可写。
  const release = await lockfile.lock(options.dataDir, {
    lockfilePath: join(options.dataDir, "server.lock"),
    stale: 10000,
    update: 2000,
    retries: 0,
  });
  let store: SqliteChatStore;
  try {
    store = new SqliteChatStore(join(options.dataDir, "state.db"));
  } catch (error) {
    await release();
    throw error;
  }
  const server = Fastify({
    logger: options.logger
      ? {
          level: "info",
          ...(options.logSink ? { stream: options.logSink } : {}),
          redact: ["req.headers.authorization", "req.headers.cookie"],
        }
      : false,
    logController: new LocalLogController(),
    bodyLimit: 65536,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  let credentials: FileCredentialStore;
  try {
    credentials = new FileCredentialStore(options.dataDir);
  } catch (error) {
    store.close();
    await release();
    throw error;
  }
  // 模型工厂支持测试注入；生产默认创建 OpenAIChatModel，每次运行使用独立配置实例。
  const settings = new SettingsService(
    store,
    credentials,
    randomUUID,
    options.modelFactory ??
      ((config, key) => new OpenAIChatModel(config.baseUrl, key, config.model)),
  );
  const chat = new ChatService(store, settings, options.timeoutMs);
  // 正式接受请求之前修补上次遗留 Run；不把它们重新加入当前 active Map 或发起模型重试。
  store.recoverInterrupted();
  const streams = new Set<() => void>();
  // 先关闭长连接使 Fastify 能退出，再取消活动模型并落终态；数据库和锁留到 onClose 释放。
  server.addHook("preClose", async () => {
    for (const end of streams) end();
    await chat.close();
  });
  server.addHook("onClose", async () => {
    store.close();
    await release();
  });
  // 本地单用户仍需防御跨站访问与 DNS rebinding；校验 Host / Origin，而不仅依赖 loopback 监听。
  server.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    let host: URL;
    try {
      host = new URL(`http://${request.headers.host ?? ""}`);
    } catch {
      throw new AppError("invalid_host", "无效的本地访问地址。", 403);
    }
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(host.hostname) ||
      host.username ||
      host.password
    )
      throw new AppError("invalid_host", "该服务仅供本机访问。", 403);
    const origin = request.headers.origin;
    const sameOrigin = `${request.protocol}://${request.headers.host}`;
    if (origin && origin !== sameOrigin && origin !== options.devOrigin)
      throw new AppError("invalid_origin", "不允许来自其他网站的请求。", 403);
    // 没有 Origin 的浏览器跨站请求也必须拒绝；非浏览器本机客户端可不发送这些头。
    if (!origin && request.headers["sec-fetch-site"] === "cross-site")
      throw new AppError("invalid_origin", "不允许跨站请求。", 403);
    if (request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
      if (
        ["POST", "PUT", "PATCH"].includes(request.method) &&
        !request.headers["content-type"]?.startsWith("application/json")
      )
        throw new AppError("invalid_content_type", "请求必须使用 JSON。", 415);
    }
  });
  // 只公开 AppError 的安全消息；验证错误和未知异常统一提示，不把原始异常对象交给日志器。
  server.setErrorHandler((error, request, reply) => {
    const known = error instanceof AppError;
    const validation =
      typeof error === "object" && error !== null && "validation" in error;
    const clientError =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500;
    const status = known ? error.status : validation || clientError ? 400 : 500;
    const code = known
      ? error.code
      : validation || clientError
        ? "invalid_input"
        : "internal_error";
    // 不记录上游异常对象、请求正文或 URL，防止兼容服务在错误中回显密钥。
    request.log.error({ code, requestId: request.id }, "Request failed");
    reply.status(status).send({
      error: {
        code,
        message: known
          ? error.message
          : validation || clientError
            ? "输入格式不正确，请检查填写内容。"
            : "本地服务处理失败，请检查数据目录或稍后重试。",
      },
    });
  });
  server.get("/healthz", async () => ({ status: "ok" }));
  server.get("/api/v1/settings", async () => settings.get());
  server.put<{ Body: SettingsInput }>(
    "/api/v1/settings",
    { schema: { body: settingsSchema } },
    async (request) => settings.save(request.body),
  );
  server.post<{ Body: SettingsInput }>(
    "/api/v1/settings/test",
    { schema: { body: settingsSchema } },
    async (request) => {
      await settings.test(request.body);
      return { ok: true };
    },
  );
  // 简单会话 CRUD 当前直接访问注入的仓储；涉及执行生命周期的生成、取消与删除由应用层协调。
  server.get("/api/v1/sessions", async () => ({
    sessions: store.listSessions(),
  }));
  server.post("/api/v1/sessions", async (_request, reply) =>
    reply.status(201).send(store.createSession()),
  );
  server.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id",
    async (request) => store.snapshot(request.params.id),
  );
  server.patch<{
    Params: { id: string };
    Body: { title: string; expectedRevision: number };
  }>(
    "/api/v1/sessions/:id",
    { schema: { body: renameSchema } },
    async (request) =>
      store.renameSession(
        request.params.id,
        request.body.title,
        request.body.expectedRevision,
      ),
  );
  server.delete<{ Params: { id: string } }>(
    "/api/v1/sessions/:id",
    async (request, reply) => {
      await chat.deleteSession(request.params.id);
      reply.status(204).send();
    },
  );
  server.post<{ Params: { id: string }; Body: RunInput }>(
    "/api/v1/sessions/:id/runs",
    { schema: { body: runSchema } },
    async (request, reply) =>
      // start 已提交 Run 后立即返回 202；不把模型网络请求绑定到这条 HTTP 响应的存活时间。
      reply.status(202).send(chat.start(request.params.id, request.body)),
  );
  server.post<{ Params: { id: string }; Body: RegenerateInput }>(
    "/api/v1/sessions/:id/regenerate",
    { schema: { body: regenerateSchema } },
    async (request, reply) =>
      reply
        .status(202)
        .send(chat.start(request.params.id, request.body, "regenerate")),
  );
  server.post<{ Params: { id: string } }>(
    "/api/v1/runs/:id/cancel",
    async (request) => chat.cancel(request.params.id),
  );
  server.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/v1/sessions/:id/events",
    async (request, reply) => {
      const sessionId = request.params.id;
      const snapshot = store.snapshot(sessionId);
      // 自动重连时浏览器的 Last-Event-ID 优先于初始 after，防止每次都从旧快照游标重复补读。
      const after = Number(
        request.headers["last-event-id"] ?? request.query.after ?? 0,
      );
      if (!Number.isSafeInteger(after) || after < 0 || after > snapshot.cursor)
        throw new AppError("invalid_cursor", "事件游标无效，请重新加载会话。");
      // SSE 接管原始响应，由本路由管理结束和背压；游标检查必须在发送响应头之前完成。
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": connected\n\n");
      let cursor = after;
      let blocked = false;
      let closed = false;
      const drain = () => {
        blocked = false;
      };
      // 从已提交事件日志读取，和模型回调解耦；缓冲区满时暂停下一轮读取，等待 drain。
      const poll = () => {
        if (closed || blocked) return;
        try {
          for (const event of store.events(sessionId, cursor)) {
            const writable = reply.raw.write(
              `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            // write 返回 false 仍表示该事件已入 socket 缓冲，因此先推进游标再暂停，不能重复写同一帧。
            cursor = event.seq;
            if (!writable) {
              blocked = true;
              break;
            }
          }
        } catch (error) {
          if (error instanceof AppError && error.code === "not_found")
            reply.raw.write("event: deleted\ndata: {}\n\n");
          else reply.raw.write("event: unavailable\ndata: {}\n\n");
          end();
        }
      };
      const timer = setInterval(poll, 250);
      // 空注释帧只保活，不消费业务事件序号；浏览器不会把它当 ChatEvent。
      const heartbeat = setInterval(() => {
        if (!closed && !blocked) blocked = !reply.raw.write(": heartbeat\n\n");
      }, 15000);
      // 订阅清理只释放定时器和 socket 监听，不调用 chat.cancel；生成由用户命令或服务退出终止。
      const end = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearInterval(heartbeat);
        streams.delete(end);
        reply.raw.off("drain", drain);
        reply.raw.end();
      };
      reply.raw.on("drain", drain);
      reply.raw.on("close", end);
      streams.add(end);
      poll();
    },
  );
  // 生产托管编译后的 Web；未命中页面路由可回退 index.html，API 或缺失资产不能伪装成页面成功。
  const webRoot = fileURLToPath(new URL("../../../web/dist", import.meta.url));
  if (options.serveWeb !== false && existsSync(webRoot)) {
    await server.register(staticPlugin, { root: webRoot, wildcard: false });
    server.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        request.headers.accept?.includes("text/html")
      )
        return reply.sendFile("index.html");
      return reply
        .status(404)
        .send({ error: { code: "not_found", message: "页面或接口不存在。" } });
    });
  }
  await server.ready();
  return { server, chat, settings, store };
}
