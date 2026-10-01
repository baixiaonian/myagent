/** 固定命令查找路径：命令分析与 Worker 共用，禁止继承模型输入或宿主 Shell 的 PATH。 */
import { dirname } from "node:path";
export function executionSearchPath(): string {
  return [
    ...new Set([
      dirname(process.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ].join(":");
}
