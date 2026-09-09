/**
 * Web 开发服务器配置：固定监听 loopback，将 API 与健康检查代理到本地后端。
 * 端口与统一开发脚本保持一致；生产环境由 Fastify 托管构建产物，不使用此代理。
 */
import { defineConfig } from "vite";

const backend = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.MYAGENT_WEB_PORT ?? 5173),
    // 不自动换端口，保证实际 Web 地址与后端允许的 devOrigin 一致。
    strictPort: true,
    proxy: { "/api": backend, "/healthz": backend },
  },
});
