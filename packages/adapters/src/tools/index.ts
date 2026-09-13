/**
 * 最小本地工具执行器：注册表同时提供 JSON Schema 和执行前校验，不按计划调度任务。
 * 时间来自注入时钟；计划仅返回声明，由应用随成功工具结果原子保存。尚无通用审批或沙箱。
 */
import {
  AppError,
  type JsonValue,
  type ToolCall,
  type ToolDefinition,
} from "@myagent/contracts";
import type { ToolContext, ToolExecutor } from "@myagent/kernel";
import { Ajv } from "ajv";
export interface LocalTool {
  definition: ToolDefinition;
  execute(
    args: { [key: string]: JsonValue },
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<JsonValue>;
}
export class LocalToolExecutor implements ToolExecutor {
  readonly definitions: ToolDefinition[];
  private readonly registry;
  constructor(tools: readonly LocalTool[]) {
    const ajv = new Ajv({
      allErrors: false,
      coerceTypes: false,
      removeAdditional: false,
    });
    this.registry = new Map(
      tools.map((tool) => [
        tool.definition.name,
        { ...tool, validate: ajv.compile(tool.definition.parameters) },
      ]),
    );
    if (this.registry.size !== tools.length)
      throw new AppError("duplicate_tool", "工具名称重复。");
    this.definitions = tools.map((t) => structuredClone(t.definition));
  }
  async execute(
    call: ToolCall,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    signal.throwIfAborted();
    const tool = this.registry.get(call.name);
    if (!tool)
      throw new AppError(
        "unknown_tool",
        `工具 ${call.name.slice(0, 100)} 未注册。`,
      );
    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch {
      throw new AppError(
        "invalid_tool_arguments",
        "工具参数必须是完整 JSON 对象。",
      );
    }
    if (!tool.validate(args))
      throw new AppError(
        "invalid_tool_arguments",
        "工具参数不符合工具声明的格式，请检查字段及类型。",
      );
    signal.throwIfAborted();
    return tool.execute(args as { [key: string]: JsonValue }, context, signal);
  }
}
export function builtinTools(now: () => Date = () => new Date()): LocalTool[] {
  return [
    {
      definition: {
        name: "update_plan",
        description:
          "可选地保存或更新本次任务的计划。传完整列表，空列表清空；可随时调整，不必先列计划，也不要求按序执行。",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["steps"],
          properties: {
            steps: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["description", "status"],
                properties: {
                  description: { type: "string", minLength: 1 },
                  status: {
                    type: "string",
                    enum: ["pending", "in_progress", "completed"],
                  },
                },
              },
            },
            explanation: { type: "string" },
          },
        },
      },
      async execute(args) {
        return args;
      },
    },
    {
      definition: {
        name: "get_current_time",
        description:
          "读取当前真实时间；timezone 可选，使用 IANA 时区名称，默认 UTC。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { timezone: { type: "string" } },
        },
      },
      async execute(args) {
        const date = now();
        const timezone =
          typeof args.timezone === "string" ? args.timezone : "UTC";
        try {
          const localTime = new Intl.DateTimeFormat("sv-SE", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZoneName: "longOffset",
            hourCycle: "h23",
          }).format(date);
          return {
            timestamp: date.getTime(),
            utc: date.toISOString(),
            timezone,
            localTime,
          };
        } catch {
          throw new AppError(
            "invalid_timezone",
            "时区无效，请使用 UTC、Asia/Shanghai 等 IANA 时区名称。",
          );
        }
      },
    },
  ];
}
