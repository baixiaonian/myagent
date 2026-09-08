import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildServer } from "./bootstrap/index.js";

const dataDir = resolve(
  process.env.MYAGENT_DATA_DIR ?? `${homedir()}/.myagent`,
);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.MYAGENT_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1";
try {
  const { server } = await buildServer({
    dataDir,
    logger: true,
    ...(process.env.MYAGENT_DEV_ORIGIN
      ? { devOrigin: process.env.MYAGENT_DEV_ORIGIN }
      : {}),
  });
  let address: string;
  try {
    address = await server.listen({ port, host });
  } catch (error) {
    await server.close();
    throw error;
  }
  console.info(`MyAgent 已启动：${address}`);
  let stopping = false;
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
