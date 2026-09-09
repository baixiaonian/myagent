/**
 * 统一开发启动器：先编译包，再并行启动 TypeScript 监听、后端监听和 Vite。
 * 跟踪自己创建的子进程组，任一入口异常或收到退出信号时收拢全部开发进程。
 */
import { spawn, spawnSync } from "node:child_process";

// 包的运行入口指向 dist，必须先完成首次编译，再让后端监听源码构建结果。
const initial = spawnSync("pnpm", ["exec", "tsc", "-b"], { stdio: "inherit" });
if (initial.status !== 0) process.exit(initial.status ?? 1);
const children = [];
let closing = false;
// 只处理下面登记的开发子进程组；先给 SIGTERM 宽限，超时后再清理仍未退出的子孙进程。
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    try {
      // 负 PID 指向由 detached 创建的独立进程组，确保 pnpm 包装层下面的 Node / Vite 一并结束。
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
  // 每个入口独立进程组，继承终端输出；devOrigin 与 Vite 端口一致，供后端跨端口开发校验。
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
