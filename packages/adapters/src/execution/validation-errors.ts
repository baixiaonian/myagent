/** 工具参数错误投影：给模型可操作的字段/约束提示，不回显参数正文、认证数据或 Ajv 原始对象。 */
import type { ErrorObject } from "ajv";

export function toolValidationMessage(
  name: string,
  errors: ErrorObject[] | null | undefined,
): string {
  const field = (value: unknown) =>
    String(value ?? "参数")
      .replace(/[^a-zA-Z0-9_./~-]/g, "?")
      .slice(0, 100);
  const details = (errors ?? []).slice(0, 3).map((error) => {
    const path = error.instancePath ? field(error.instancePath) : "参数";
    switch (error.keyword) {
      case "required":
        return `缺少必填字段 ${field(error.params.missingProperty)}`;
      case "additionalProperties":
        return `不支持字段 ${field(error.params.additionalProperty)}`;
      case "maximum":
        return `${path} 不能超过 ${Number(error.params.limit)}`;
      case "minimum":
        return `${path} 不能小于 ${Number(error.params.limit)}`;
      case "type":
        return `${path} 必须为 ${field(error.params.type)}`;
      case "maxLength":
        return `${path} 长度不能超过 ${Number(error.params.limit)}`;
      default:
        return `${path} 不满足 ${field(error.keyword)} 约束，请按工具 Schema 修改`;
    }
  });
  const hint =
    name === "wait_agents"
      ? "timeoutMs 范围 1–120000；等待更久请在 timeout 后再次 wait_agents，不要改用 sleep 轮询。"
      : name === "read_process"
        ? "waitMs 范围 0–10000；用返回的 cursor 继续读取。"
        : name === "exec_command"
          ? "命令字段名为 command，不是 cmd；未执行任何命令。"
          : "本次工具尚未执行。";
  return `工具参数错误：${details.join("；") || "不符合声明的 Schema"}。${hint}`;
}
