/**
 * 受控进程组清理：不仅检查主进程的 close，还检查同组后代，防止后台子进程继续写文件。
 * 只接受本监督器创建的进程组 ID；无法确认退出时返回 false，由应用保留结果未知状态。
 */

import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
export async function processBirthTime(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  return new Promise((resolve) =>
    execFile(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 2000 },
      (error, output) => resolve(error ? null : output.trim() || null),
    ),
  );
}
export function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code !== "ESRCH",
    );
  }
}
async function waitGroup(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (processGroupExists(pid) && Date.now() < end) await delay(25);
  return !processGroupExists(pid);
}
export async function terminateProcessGroup(
  pid: number,
  grace = 2000,
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  if (!processGroupExists(pid)) return true;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* 收到 ESRCH 仍通过进程组检查确认。 */
  }
  if (await waitGroup(pid, grace)) return true;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* 无权限或系统失败不能被当作成功。 */
  }
  return waitGroup(pid, 2000);
}
