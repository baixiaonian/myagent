import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import { mockProvider } from "../chat/provider.js";

const dataDir = mkdtempSync(join(tmpdir(), "myagent-e2e-"));
const provider = await mockProvider(14318);
const { server } = await buildServer({ dataDir, logger: false });
await server.listen({ host: "127.0.0.1", port: 14317 });
console.info(
  "本地测试实例 http://127.0.0.1:14317；模拟模型 http://127.0.0.1:14318/v1",
);
let closing = false;
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
