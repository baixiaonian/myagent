import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
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
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
