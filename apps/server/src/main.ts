/**
 * 本地后端进程入口：解析数据目录、监听地址与端口，装配服务器并处理退出信号。
 * 业务路由与资源回收由 bootstrap 管理；启动失败只输出安全提示，不打印底层异常。
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { type AgentLimits, AppError } from "@myagent/contracts";
import { buildServer } from "./bootstrap/index.js";

const dataDir = resolve(
  process.env.MYAGENT_DATA_DIR ?? `${homedir()}/.myagent`,
);
const port = Number(process.env.PORT ?? 3000);
// 容器内需监听所有接口才能被端口映射访问；宿主 Compose 仍只映射 127.0.0.1。
const host = process.env.MYAGENT_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1";
try {
  const agentLimits: Partial<AgentLimits> = {};
  const variables = {
    modelTimeoutMs: "MYAGENT_MODEL_TIMEOUT_MS",
    toolTimeoutMs: "MYAGENT_TOOL_TIMEOUT_MS",
    commandTimeoutMs: "MYAGENT_COMMAND_TIMEOUT_MS",
    contextCharacters: "MYAGENT_CONTEXT_CHARACTERS",
    historyTurns: "MYAGENT_HISTORY_TURNS",
    toolResultCharacters: "MYAGENT_TOOL_RESULT_CHARACTERS",
  } as const;
  for (const [key, name] of Object.entries(variables)) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
      throw new AppError("invalid_limits", "资源配置必须为有效正整数。");
    agentLimits[key as keyof AgentLimits] = value;
  }
  // 旧环境变量不再建立整项任务的硬截止；提示迁移，不能悄悄复活旧限制。
  if (
    process.env.MYAGENT_RUN_TIMEOUT_MS !== undefined ||
    process.env.MYAGENT_OUTPUT_CHARACTERS !== undefined
  )
    console.warn(
      "MYAGENT_RUN_TIMEOUT_MS / MYAGENT_OUTPUT_CHARACTERS 已停用；任务不再受累计时长或产出限制。",
    );
  const { server } = await buildServer({
    dataDir,
    captureFileLimit: Number(
      process.env.MYAGENT_CAPTURE_FILE_BYTES ?? 20 * 1024 ** 2,
    ),
    captureTotalLimit: Number(
      process.env.MYAGENT_CAPTURE_TOTAL_BYTES ?? 1024 ** 3,
    ),
    ...(process.env.MYAGENT_OTLP_ENABLED === "1"
      ? {
          otlpEndpoint:
            process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
            "http://127.0.0.1:4318/v1/traces",
          otlpHeaders: Object.fromEntries(
            (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "")
              .split(",")
              .filter(Boolean)
              .map((entry) => {
                const index = entry.indexOf("=");
                if (index < 1) throw Error("invalid OTLP header");
                return [
                  entry.slice(0, index),
                  decodeURIComponent(entry.slice(index + 1)),
                ];
              }),
          ),
        }
      : {}),
    teamMaxMembers: Number(process.env.MYAGENT_TEAM_MAX_MEMBERS ?? 8),
    teamModelConcurrency: Number(
      process.env.MYAGENT_TEAM_MODEL_CONCURRENCY ?? 4,
    ),
    workspaceRoot: resolve(
      process.env.MYAGENT_WORKSPACE_ROOT ?? `${homedir()}/MyAgent/Workspaces`,
    ),
    skillRoot: resolve(
      process.env.MYAGENT_SKILL_ROOT ?? `${homedir()}/MyAgent/Skills`,
    ),
    skillLimits: {
      fileBytes: Number(process.env.MYAGENT_SKILL_FILE_BYTES ?? 20 * 1024 ** 2),
      packageBytes: Number(
        process.env.MYAGENT_SKILL_PACKAGE_BYTES ?? 100 * 1024 ** 2,
      ),
      files: Number(process.env.MYAGENT_SKILL_FILES ?? 10000),
    },
    logger: true,
    agentLimits,
    ...(process.env.MYAGENT_DEV_ORIGIN
      ? { devOrigin: process.env.MYAGENT_DEV_ORIGIN }
      : {}),
  });
  let address: string;
  try {
    address = await server.listen({ port, host });
  } catch (error) {
    // 监听失败也走关闭钩子，释放刚装配的数据库与目录锁，避免下一次启动被自己阻塞。
    await server.close();
    throw error;
  }
  console.info(`MyAgent 已启动：${address}`);
  let stopping = false;
  // 信号可能重复到达，幂等地关闭一次；等待 bootstrap 完成中断提交和资源释放。
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
  };
  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });
} catch {
  console.error(
    "MyAgent 启动失败：请检查端口、数据目录权限及是否已有实例运行。异常退出后的目录锁约 10 秒失效。",
  );
  process.exitCode = 1;
}
