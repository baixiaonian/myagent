/** 团队工具定义：只描述协调能力；最终身份校验和派发在应用层，不能用参数伪造主 Agent。 */
import type { JsonValue, ToolDescriptor } from "@myagent/contracts";

const text = { type: "string", minLength: 1, maxLength: 8000 };
const object = (
  properties: Record<string, JsonValue>,
  required: string[] = [],
) => ({ type: "object", additionalProperties: false, properties, required });
export function teamToolDescriptors(): ToolDescriptor[] {
  return [
    {
      name: "spawn_agent",
      description:
        "仅主 Agent：按需创建成员，名称、职责与任务由你决定。返回 agentId 后异步执行。你仍对整体交付负责，可以亲自执行；成员共享项目，需要协调文件分工。最终交付前收齐结果或停止不再需要的成员；普通问题不必创建。",
      parameters: object(
        {
          name: { ...text, maxLength: 80 },
          instructions: { ...text, maxLength: 4000 },
          task: text,
          context: object(
            {
              mode: { enum: ["brief", "recent", "full"] },
              turns: { type: "integer", minimum: 1, maximum: 100 },
            },
            ["mode"],
          ),
        },
        ["name", "instructions", "task"],
      ),
    },
    {
      name: "send_message",
      description:
        "向当前团队的 agentId（或 main）直接通信。request 要求处理，可唤醒空闲成员；inform 提供资料/回复，不唤醒空闲成员。replyTo 关联实际收到的消息 ID。发送成功不代表对方完成。",
      parameters: object(
        {
          agentId: text,
          content: text,
          kind: { enum: ["request", "inform"] },
          replyTo: text,
          resultRefs: { type: "array", maxItems: 20, items: text },
        },
        ["agentId", "content", "kind"],
      ),
    },
    {
      name: "list_agents",
      description:
        "查看本对话的可复用成员、当前任务、状态及结果入口，不产生模型请求。",
      parameters: object({}),
    },
    {
      name: "wait_agents",
      description:
        "等待成员变化或收件箱消息，可用 agentIds 指定范围。timeoutMs 单位毫秒，范围 1–120000，默认 30000；超过两分钟时可在 timeout 后再次等待。事件到达立即返回，不占项目锁和工具槽，禁止用 exec_command 的 sleep/文件轮询代替。请先处理本 Run 持锁进程；循环等待返回错误，由你协调。",
      parameters: object({
        agentIds: { type: "array", maxItems: 128, items: text },
        timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
      }),
    },
    {
      name: "read_agent_history",
      description:
        "分页查看成员过程。主 Agent 可查所有成员；成员只可查自身及明确共享给自己的消息。cursor 继续读取原文，单次结果有界。",
      parameters: object(
        { agentId: text, cursor: { type: "string", maxLength: 100 } },
        ["agentId"],
      ),
    },
    {
      name: "stop_agent",
      description:
        "仅主 Agent：停止成员当前工作；close=true 关闭成员并释放名额，不删除历史或回滚文件。",
      parameters: object({ agentId: text, close: { type: "boolean" } }, [
        "agentId",
      ]),
    },
  ].map(
    (spec) =>
      ({
        ...spec,
        source: { kind: "local" },
        effects: "read",
        concurrency: "exclusive",
        requiresWorkspace: false,
        version: "team-v1",
      }) as ToolDescriptor,
  );
}
