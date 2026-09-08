import { describe, expect, it } from "vitest";
import { AppError, type Message } from "../../packages/contracts/src/index.js";
import {
  buildContext,
  type ModelPort,
  runChat,
} from "../../packages/kernel/src/index.js";

function pair(i: number, size = 1): Message[] {
  const common = {
    sessionId: "s",
    runId: `r${i}`,
    status: "completed" as const,
    createdAt: "now",
  };
  return [
    {
      ...common,
      id: `q${i}`,
      role: "user",
      content: "Q".repeat(size),
      replyToId: null,
    },
    {
      ...common,
      id: `a${i}`,
      role: "assistant",
      content: "A".repeat(size),
      replyToId: `q${i}`,
    },
  ];
}
describe("context", () => {
  it("preserves system, complete pairs and current question in order", () => {
    const history = [...pair(1), ...pair(2)];
    const incomplete = history[3];
    if (!incomplete) throw new Error("Missing fixture answer");
    incomplete.status = "failed";
    const result = buildContext(history, "next", "system");
    expect(result.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "Q" },
      { role: "assistant", content: "A" },
      { role: "user", content: "next" },
    ]);
  });
  it("trims only whole rounds by count and characters", () => {
    const result = buildContext(
      Array.from({ length: 22 }, (_, i) => pair(i)).flat(),
      "new",
      "system",
    );
    expect(result.trimmed).toBe(true);
    expect(result.messages).toHaveLength(42);
    const large = buildContext(
      [...pair(0, 7000), ...pair(1, 7000), ...pair(2, 7000)],
      "new",
      "system",
    );
    expect(large.messages).toHaveLength(6);
    expect(large.trimmed).toBe(true);
    expect(() => buildContext([], "x".repeat(8001), "")).toThrow();
  });
});
describe("single-call runtime", () => {
  it("streams text and requires a terminal response", async () => {
    const model: ModelPort = {
      async *stream() {
        yield { type: "text", text: "你好" };
        yield { type: "done", finishReason: "stop", usage: null };
      },
    };
    const text: string[] = [];
    expect(
      await runChat(model, [], new AbortController().signal, (part) =>
        text.push(part),
      ),
    ).toEqual({ finishReason: "stop", usage: null });
    expect(text.join("")).toBe("你好");
    await expect(
      runChat(
        {
          async *stream() {
            yield { type: "text", text: "partial" };
          },
        },
        [],
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "incomplete_stream" });
  });
  it("terminates timeout and cancellation even if iterator ignores the signal", async () => {
    const hang: ModelPort = {
      stream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      }),
    };
    await expect(
      runChat(hang, [], new AbortController().signal, () => {}, 20),
    ).rejects.toMatchObject({ code: "timeout" });
    const abort = new AbortController();
    const pending = runChat(hang, [], abort.signal, () => {});
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
  it("propagates model failures", async () => {
    const model: ModelPort = {
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new AppError("rate_limited", "稍后重试");
          },
        }),
      }),
    };
    await expect(
      runChat(model, [], new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});
