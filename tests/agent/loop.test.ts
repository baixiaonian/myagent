/**
 * 自主循环与上下文契约验证：通过可控模型脚本检验真正的决策/工具往返和终止边界。
 * 模型脚本只制造明确输入输出；没有任何用它替代真实服务商验收的含义。
 */
import { describe, expect, it } from "vitest";
import {
  builtinTools,
  LocalToolExecutor,
} from "../../packages/adapters/src/index.js";
import {
  AGENT_LIMITS,
  AppError,
  type JsonValue,
  type RunStep,
  type ToolCall,
} from "../../packages/contracts/src/index.js";
import {
  type AgentOptions,
  defaultContextBuilder,
  type ModelMessage,
  type ModelPort,
  type ModelResponse,
  runAgent,
  type ToolExecutor,
} from "../../packages/kernel/src/index.js";

function scripted(
  replies: (ModelResponse & { finishReason?: string })[],
  inputs: ModelMessage[][] = [],
): ModelPort {
  let index = 0;
  return {
    async *stream(messages) {
      inputs.push(structuredClone([...messages]));
      const response = replies[index++];
      if (!response)
        throw new AppError("unexpected_request", "意外重复调用模型。");
      if (response.content) yield { type: "text", text: response.content };
      yield {
        type: "done",
        finishReason:
          response.finishReason ??
          (response.toolCalls.length ? "tool_calls" : "stop"),
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        response,
      };
    },
  };
}
const call = (
  id = "time",
  name = "get_current_time",
  args = "{}",
): ToolCall => ({ id, name, arguments: args });
const executor = () =>
  new LocalToolExecutor(builtinTools(() => new Date("2026-09-12T00:00:00Z")));
function options(model: ModelPort, steps: RunStep[] = []): AgentOptions {
  return {
    runId: "r",
    model,
    current: [{ role: "user", content: "完成任务" }],
    tools: executor(),
    signal: new AbortController().signal,
    onEvent(e) {
      if (e.type === "step.updated") steps.push(e.step);
    },
  };
}
describe("autonomous loop", () => {
  it("answers directly with tools available, without a mandatory plan", async () => {
    const steps: RunStep[] = [];
    await expect(
      runAgent(options(scripted([{ content: "你好", toolCalls: [] }]), steps)),
    ).resolves.toEqual({
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
    expect(steps.at(-1)?.tools).toEqual([]);
  });
  it("handles tool-only response, preserves paired results, and sums actual usage", async () => {
    const input: ModelMessage[][] = [];
    const result = await runAgent(
      options(
        scripted(
          [
            { content: "", toolCalls: [call()] },
            { content: "已经查到", toolCalls: [] },
          ],
          input,
        ),
      ),
    );
    expect(result.usage?.totalTokens).toBe(10);
    expect(input[1]?.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(input[1]?.at(-1)?.callId).toBe("time");
    expect(input[1]?.at(-1)?.content).toContain("2026-09-12");
  });
  it("executes a full batch in order, and only after durable callback completion", async () => {
    const order: string[] = [];
    const base = options(
      scripted([
        { content: "先处理", toolCalls: [call("a"), call("b")] },
        { content: "完成", toolCalls: [] },
      ]),
    );
    base.onEvent = async (e) => {
      if (e.type === "step.updated") {
        await Promise.resolve();
        order.push(e.step.tools.map((t) => `${t.id}:${t.status}`).join(","));
      }
    };
    base.tools = {
      definitions: executor().definitions,
      async execute(c) {
        order.push(`execute:${c.id}`);
        return "ok";
      },
    };
    await runAgent(base);
    expect(order.indexOf("a:running,b:pending")).toBeLessThan(
      order.indexOf("execute:a"),
    );
    expect(order.indexOf("execute:a")).toBeLessThan(order.indexOf("execute:b"));
    expect(order.indexOf("a:succeeded,b:running")).toBeLessThan(
      order.indexOf("execute:b"),
    );
  });
  it.each([
    ["missing", "{}", "unknown_tool"],
    ["get_current_time", "{", "invalid_tool_arguments"],
    ["get_current_time", '{"timezone":42}', "invalid_tool_arguments"],
    ["get_current_time", '{"timezone":"Unknown/Place"}', "invalid_timezone"],
  ])(
    "returns %s error as feedback and allows model correction",
    async (name, args, code) => {
      const input: ModelMessage[][] = [];
      await runAgent(
        options(
          scripted(
            [
              { content: "", toolCalls: [call("bad", name, args)] },
              { content: "", toolCalls: [call("fixed")] },
              { content: "完成", toolCalls: [] },
            ],
            input,
          ),
        ),
      );
      expect(input[1]?.at(-1)?.content).toContain(code);
      expect(input).toHaveLength(3);
    },
  );
  it("plans can change, clear, have several active items, and never finish the run themselves", async () => {
    const input: ModelMessage[][] = [];
    const plan = JSON.stringify({
      steps: [
        { description: "A", status: "in_progress" },
        { description: "B", status: "in_progress" },
      ],
    });
    await runAgent(
      options(
        scripted(
          [
            { content: "", toolCalls: [call("p1", "update_plan", plan)] },
            {
              content: "",
              toolCalls: [call("p2", "update_plan", '{"steps":[]}')],
            },
            { content: "结束", toolCalls: [] },
          ],
          input,
        ),
      ),
    );
    expect(input).toHaveLength(3);
    expect(input[2]?.at(-1)?.content).toBe('{"steps":[]}');
  });
  it.each([
    [[call("")], "tool_calls", "model_protocol"],
    [[call("a"), call("a")], "tool_calls", "model_protocol"],
    [[call()], "length", "model_incomplete"],
    [[], "tool_calls", "model_protocol"],
  ])(
    "does not execute malformed or truncated batches",
    async (calls, finishReason, code) => {
      let executions = 0;
      const base = options(
        scripted([
          {
            content: "partial",
            toolCalls: calls as ToolCall[],
            finishReason: finishReason as string,
          },
        ]),
      );
      base.tools = {
        definitions: [],
        async execute() {
          executions++;
          return null;
        },
      };
      await expect(runAgent(base)).rejects.toMatchObject({ code });
      expect(executions).toBe(0);
    },
  );
  it("does not execute tools when persistence fails", async () => {
    let calls = 0;
    const base = options(scripted([{ content: "", toolCalls: [call()] }]));
    base.onEvent = (e) => {
      if (e.type === "step.updated" && e.step.tools.length)
        throw new Error("disk unavailable");
    };
    base.tools = {
      definitions: [],
      async execute() {
        calls++;
        return null;
      },
    };
    await expect(runAgent(base)).rejects.toThrow("disk unavailable");
    expect(calls).toBe(0);
  });
  it("stops a hanging tool and never dispatches the remaining batch", async () => {
    const controller = new AbortController();
    let executions = 0;
    const steps: RunStep[] = [];
    const base = options(
      scripted([{ content: "", toolCalls: [call("a"), call("b")] }]),
      steps,
    );
    base.signal = controller.signal;
    base.tools = {
      definitions: [],
      execute() {
        executions++;
        controller.abort();
        return new Promise(() => {});
      },
    };
    await expect(runAgent(base)).rejects.toMatchObject({ code: "cancelled" });
    expect(executions).toBe(1);
    expect(steps.at(-1)?.tools.map((t) => t.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });
  it("tool timeout becomes feedback; single model request timeout still terminates", async () => {
    const input: ModelMessage[][] = [];
    const base = options(
      scripted(
        [
          { content: "", toolCalls: [call()] },
          { content: "工具超时", toolCalls: [] },
        ],
        input,
      ),
    );
    base.tools = { definitions: [], execute: () => new Promise(() => {}) };
    base.limits = { toolTimeoutMs: 10 };
    await runAgent(base);
    expect(input[1]?.at(-1)?.content).toContain("tool_timeout");
    const hang: ModelPort = {
      stream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      }),
    };
    await expect(
      runAgent({ ...options(hang), limits: { modelTimeoutMs: 10 } }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
  it("accounts for non-text output and reports missing usage without guessing", async () => {
    const model: ModelPort = {
      async *stream() {
        // 真正跨过旧 1ms 总时限；每次模型请求自己的超时仍保持生效。
        await new Promise((resolve) => setTimeout(resolve, 25));
        yield { type: "output", characters: 200 };
        yield {
          type: "done",
          finishReason: "stop",
          usage: null,
          response: { content: "hi", toolCalls: [] },
        };
      },
    };
    const base = options(model);
    // 模拟旧调用方/检查点残留的废弃配置，不能重新引入硬上限。
    const legacy = Object.assign(
      { ...AGENT_LIMITS },
      { outputCharacters: 1, runTimeoutMs: 1 },
    );
    let counted = 0;
    const result = await runAgent({
      ...base,
      limits: legacy,
      accountOutput: (size) => {
        counted += size;
      },
    });
    expect(counted).toBeGreaterThanOrEqual(200);
    expect(result.usage).toBeNull();
  });
  it("truncates only the model view of a tool result", async () => {
    const input: ModelMessage[][] = [];
    const steps: RunStep[] = [];
    const tools: ToolExecutor = {
      definitions: [],
      execute: async () => "x".repeat(500),
    };
    await runAgent({
      ...options(
        scripted(
          [
            { content: "", toolCalls: [call()] },
            { content: "done", toolCalls: [] },
          ],
          input,
        ),
        steps,
      ),
      tools,
      limits: { toolResultCharacters: 80 },
    });
    expect(input[1]?.at(-1)?.content.length).toBeLessThanOrEqual(80);
    expect(input[1]?.at(-1)?.content).toContain("截断");
    expect(steps.findLast((s) => s.tools.length)?.tools[0]?.result?.data).toBe(
      "x".repeat(500),
    );
  });
});
describe("context units", () => {
  it("preserves current tool chain and continuation; trims entire prior turns", () => {
    const continuation: JsonValue = {
      protocol: "responses",
      items: [{ type: "reasoning", encrypted_content: "opaque" }],
    };
    const current: ModelMessage[] = [
      { role: "user", content: "now" },
      { role: "assistant", content: "", toolCalls: [call()], continuation },
      { role: "tool", callId: "time", content: "ok" },
    ];
    const output = defaultContextBuilder.build({
      instructions: "system",
      history: [
        [
          { role: "user", content: "x".repeat(1000) },
          { role: "assistant", content: "y" },
        ],
      ],
      current,
      tools: [],
      limits: { ...AGENT_LIMITS, contextCharacters: 500 },
    });
    expect(output.messages.slice(1)).toEqual(current);
    expect(output.trimmed).toBe(true);
    expect(() =>
      defaultContextBuilder.build({
        instructions: "",
        history: [],
        current,
        tools: [],
        limits: { ...AGENT_LIMITS, contextCharacters: 10 },
      }),
    ).toThrow(/上下文/);
  });
});
