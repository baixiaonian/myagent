/** 沙箱内 Hook 单次入口：固定解释器以 argv 启动；事件只写 stdin，不经过 Shell 字符串插值。 */
import { spawn } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (Buffer.byteLength(input) > 262144)
    throw new Error("Hook input exceeds limit");
}
const invocation = JSON.parse(input) as {
  interpreterPath: string;
  entryPath: string;
  args: string[];
  input: unknown;
};
const child = spawn(
  invocation.interpreterPath,
  [invocation.entryPath, ...invocation.args],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "inherit", "inherit"],
  },
);
child.stdin.on("error", () => {
  /* 脚本提前关闭 stdin 不导致第二次执行。 */
});
child.stdin.end(JSON.stringify(invocation.input));
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
