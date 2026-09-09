/**
 * 本地后端进程入口：解析数据目录、监听地址与端口，装配服务器并处理退出信号。
 * 业务路由与资源回收由 bootstrap 管理；启动失败只输出安全提示，不打印底层异常。
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildServer } from "./bootstrap/index.js";

const dataDir = resolve(
  process.env.MYAGENT_DATA_DIR ?? `${homedir()}/.myagent`,
);
const port = Number(process.env.PORT ?? 3000);
// 容器内需监听所有接口才能被端口映射访问；宿主 Compose 仍只映射 127.0.0.1。
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
