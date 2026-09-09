/**
 * 浏览器验收配置：串行运行产品流程，启动专用测试后端并保留失败截图和 Trace。
 * 不复用已有服务、不自动重试；14317 / 14318 仅供隔离的产品与假模型测试。
 */
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  // 测试共用专用服务，按顺序清理与运行；关闭重试避免掩盖竞态或重复执行有副作用的步骤。
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:14317",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1360, height: 900 },
  },
  webServer: {
    command: "pnpm exec tsx tests/e2e/serve.ts",
    url: "http://127.0.0.1:14317/healthz",
    // 端口被占用应报错，不能误用用户正在运行的真实配置服务。
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
