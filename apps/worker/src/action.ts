/**
 * Worker 子进程的单次文件动作入口：仅从 stdin 读取执行信封，stdout 只返回一个 JSON 结果。
 * 标准模式由沙箱隔离应用数据；完全访问可读取用户指定路径。两种模式均由 Worker 监督生命周期和输出额度。
 */
import { executeFileTool } from "@myagent/adapters";
import {
  AppError,
  type JsonValue,
  type ResourceAccess,
} from "@myagent/contracts";

try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 500000)
      throw new AppError("input_limit", "文件操作输入超过限制。");
  }
  const request = JSON.parse(input) as {
    name: string;
    arguments: Record<string, JsonValue>;
    resources: ResourceAccess[];
  };
  const data = await executeFileTool(
    request.name,
    request.arguments,
    request.resources,
  );
  process.stdout.write(JSON.stringify({ ok: true, data }));
} catch (error) {
  const safe =
    error instanceof AppError
      ? { code: error.code, message: error.message }
      : {
          code: "file_error",
          message: "文件操作失败，请检查路径、权限与文件状态。",
        };
  process.stdout.write(JSON.stringify({ ok: false, error: safe }));
  process.exitCode = 1;
}
