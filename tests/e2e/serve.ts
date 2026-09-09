/**
 * 端到端测试服务入口：创建临时数据目录、本地协议替身和生产 Web 托管服务。
 * 收到退出信号时先关闭生成与连接，再删除自己创建的数据，绝不复用用户目录。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import { mockProvider } from "../chat/provider.js";

// 专用端口由 Playwright 配置约定，临时目录由本进程创建；冲突时失败，不接管其他服务。
const dataDir = mkdtempSync(join(tmpdir(), "myagent-e2e-"));
const provider = await mockProvider(14318);
const { server } = await buildServer({ dataDir, logger: false });
await server.listen({ host: "127.0.0.1", port: 14317 });
console.info(
  "本地测试实例 http://127.0.0.1:14317；模拟模型 http://127.0.0.1:14318/v1",
);
let closing = false;
// 先停止生成并关闭数据库，再关假模型和删除目录，避免异步写入落到已删除路径。
const stop = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  await provider.close();
  rmSync(dataDir, { recursive: true, force: true });
};
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
