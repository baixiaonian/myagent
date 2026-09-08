import { spawn, spawnSync } from "node:child_process";

const initial = spawnSync("pnpm", ["exec", "tsc", "-b"], { stdio: "inherit" });
if (initial.status !== 0) process.exit(initial.status ?? 1);
const children = [];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    process.exit(code);
  }, 2500).unref();
}
for (const args of [
  ["exec", "tsc", "-b", "--watch", "--preserveWatchOutput"],
  ["exec", "node", "--watch", "apps/server/dist/main.js"],
  ["--filter", "@myagent/web", "dev"],
]) {
  const child = spawn("pnpm", args, {
    stdio: "inherit",
    detached: true,
    env: {
      ...process.env,
      MYAGENT_DEV_ORIGIN: `http://127.0.0.1:${process.env.MYAGENT_WEB_PORT ?? "5173"}`,
    },
  });
  children.push(child);
  child.on("exit", (code) => {
    if (!closing) stop(code || 1);
  });
  child.on("error", () => stop(1));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
