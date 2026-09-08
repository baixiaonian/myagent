import { defineConfig } from "vite";

const backend = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.MYAGENT_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": backend, "/healthz": backend },
  },
});
