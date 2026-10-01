/** 团队调度原语验收：FIFO、公平取消和循环等待检测，确保等待不吞掉真实执行名额。 */
import { expect, it } from "vitest";
import {
  createsWaitCycle,
  TeamCoordinator,
} from "../../packages/orchestration/src/index.js";

it("cancelled waiter is removed and releases are idempotent", async () => {
  const coordinator = new TeamCoordinator(1);
  const first = await coordinator.acquire(new AbortController().signal);
  const cancel = new AbortController();
  const second = coordinator.acquire(cancel.signal);
  const observed = expect(second).rejects.toBe("stop");
  const third = coordinator.acquire(new AbortController().signal);
  cancel.abort("stop");
  await observed;
  first();
  first();
  const release = await third;
  release();
  expect(typeof (await coordinator.acquire(new AbortController().signal))).toBe(
    "function",
  );
});
it("detects a cycle but allows an independent wait", () => {
  const edges = new Map([
    ["A", ["B"]],
    ["B", ["main"]],
  ]);
  expect(createsWaitCycle("main", ["A"], edges)).toBe(true);
  expect(createsWaitCycle("C", ["A"], edges)).toBe(false);
});
