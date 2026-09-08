import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: ["research/**", "**/dist/**", "**/node_modules/**"],
    environment: "node",
  },
});
