/**
 * 工程及单元 / 集成测试入口：收集项目测试和包内用例，在 Node 环境执行。
 * 排除研究上游、编译产物和依赖；浏览器验收由独立 Playwright 命令负责。
 */
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: ["research/**", "**/dist/**", "**/node_modules/**"],
    environment: "node",
  },
});
