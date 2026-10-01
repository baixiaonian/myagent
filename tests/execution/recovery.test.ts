/**
 * 生命周期故障注入：真实应用/SQLite，受控模型和网关制造审批、断连、未知结果及恢复边界。
 * 模拟派发只用于验证调度事实，不替代 native.test.ts 的真实 OS 隔离与进程证据。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import {
  AGENT_LIMITS,
  type ToolCall,
} from "../../packages/contracts/src/index.js";
import type { ModelPort } from "../../packages/kernel/src/index.js";

let root: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let requests = 0;
let effects = 0;
let calls: ToolCall[] = [];
let outcome: "succeeded" | "unknown" = "succeeded";
const model: ModelPort = {
  async *stream(messages) {
    requests++;
    const replied = messages.some((message) => message.role === "tool");
    yield {
      type: "done",
      finishReason: replied ? "stop" : "tool_calls",
      usage: null,
      response: {
        content: replied ? "已根据工具反馈完成。" : "",
        toolCalls: replied ? [] : calls,
      },
    };
  },
};
async function open() {
  app = await buildServer({
    dataDir: join(root, "data"),
    serveWeb: false,
    modelFactory: () => model,
  });
  // 模拟网关依旧履行“派发前记录 accepted”的协议；丢失回执时不能当成没有副作用。
  app.gateway.dispatch = async (request) => {
    effects++;
    await request.onAccepted?.(null);
    return {
      attemptId: request.attemptId,
      invocationId: request.context.invocationId,
      outcome,
      data: outcome === "succeeded" ? { text: "已读取" } : null,
      error:
        outcome === "unknown" ? { code: "lost", message: "回执丢失" } : null,
      effectsPossible: outcome === "unknown",
      completedAt: new Date().toISOString(),
    };
  };
}
async function session() {
  const workspace = await app.toolSystem.createWorkspace(
    join(root, "work"),
    "测试工作区",
  );
  const value = app.store.createSession();
  app.store.execution.bindWorkspace(value.id, workspace.id, value.revision);
  return app.store.snapshot(value.id).session;
}
async function until(runId: string, status: string) {
  for (let index = 0; index < 400; index++) {
    if (app.store.getRun(runId).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`expected ${status}; got ${app.store.getRun(runId).status}`);
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "myagent-recovery-")));
  await mkdir(join(root, "work"));
  await mkdir(join(root, "outside"));
  requests = 0;
  effects = 0;
  outcome = "succeeded";
  calls = [
    {
      id: "read",
      name: "read_file",
      arguments: JSON.stringify({ path: join(root, "outside", "note.txt") }),
    },
  ];
  await open();
  app.settings.save({
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    apiProtocol: "responses",
    apiKey: "fixture-only",
    systemPrompt: "",
    expectedRevision: 0,
  });
});
afterEach(async () => {
  await app?.server.close();
  if (root) await rm(root, { recursive: true, force: true });
});
it("审批前无动作；重启不调用模型，批准后复用完整模型调用并只派发一次", async () => {
  const current = await session();
  const run = app.chat.start(current.id, {
    requestId: randomUUID(),
    expectedRevision: current.revision,
    content: "帮我看一下外面的文件",
  }).run;
  await until(run.id, "waiting_approval");
  expect(requests).toBe(1);
  expect(effects).toBe(0);
  // 升级前已耗尽累计时间/产出的暂停任务，升级后人工继续不能再被旧阈值拒绝。
  const legacy = app.store.execution.get("checkpoints", run.id);
  if (!legacy) throw new Error("legacy checkpoint missing");
  Object.assign(legacy.limits, { runTimeoutMs: 1, outputCharacters: 1 });
  legacy.activeMilliseconds = 700000;
  if (legacy.runtime && typeof legacy.runtime === "object")
    Object.assign(legacy.runtime, { output: 300000 });
  app.store.execution.put("checkpoints", legacy);
  await app.server.close();
  await open();
  expect(requests).toBe(1);
  expect(effects).toBe(0);
  const approval = app.store.execution.list("approvals", { runId: run.id })[0];
  if (!approval) throw new Error("missing approval");
  const decision = {
    requestId: randomUUID(),
    decision: "allow" as const,
    scope: "workspace" as const,
  };
  app.toolSystem.decide(approval.id, decision);
  app.toolSystem.decide(approval.id, decision);
  expect(() =>
    app.toolSystem.decide(approval.id, { ...decision, decision: "deny" }),
  ).toThrow();
  await app.chat.resume(run.id);
  await until(run.id, "succeeded");
  expect(requests).toBe(2);
  expect(effects).toBe(1);
  expect(app.store.snapshot(current.id).steps?.at(0)?.tools[0]).toMatchObject({
    id: "read",
    status: "succeeded",
  });
});
it("拒绝和过期审批返回工具错误，模型自行结束；等待用户不消耗活动预算", async () => {
  const current = await session();
  const run = app.chat.start(current.id, {
    requestId: randomUUID(),
    expectedRevision: current.revision,
    content: "读取外部资料",
  }).run;
  await until(run.id, "waiting_approval");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const approval = app.store.execution.list("approvals", { runId: run.id })[0];
  const checkpoint = app.store.execution.get("checkpoints", run.id);
  if (!approval || !checkpoint) throw new Error("missing checkpoint");
  checkpoint.activeMilliseconds = 10;
  checkpoint.updatedAt = new Date(Date.now() - 200000).toISOString();
  app.store.execution.put("checkpoints", checkpoint);
  approval.expiresAt = new Date(Date.now() - 1).toISOString();
  app.store.execution.put("approvals", approval);
  await app.chat.maintain();
  expect(
    app.store.execution.get("checkpoints", run.id)?.activeMilliseconds,
  ).toBe(10);
  expect(app.store.execution.get("approvals", approval.id)?.status).toBe(
    "expired",
  );
  await app.chat.resume(run.id);
  await until(run.id, "succeeded");
  expect(effects).toBe(0);
  expect(requests).toBe(2);
  expect(
    app.store.snapshot(current.id).steps?.[0]?.tools[0]?.result?.error?.code,
  ).toBe("approval_denied");
});
it("执行结果未知保留原回执，换调用 ID 不能绕过；删除后保留最小隔离资料", async () => {
  calls = [
    {
      id: "write",
      name: "write_file",
      arguments: JSON.stringify({
        path: join(root, "work", "target.txt"),
        content: "内容",
        expectedHash: null,
      }),
    },
  ];
  outcome = "unknown";
  const current = await session();
  const run = app.chat.start(current.id, {
    requestId: randomUUID(),
    expectedRevision: current.revision,
    content: "整理这份文件",
  }).run;
  await until(run.id, "waiting_reconciliation");
  expect(effects).toBe(1);
  await app.chat.deleteSession(current.id);
  expect(app.store.listSessions()).toHaveLength(0);
  const concern = app.store.execution.list("concerns")[0];
  if (!concern) throw new Error("missing concern");
  expect(JSON.stringify(concern)).not.toContain("内容");
  const second = await session();
  calls = [{ ...(calls[0] as ToolCall), id: "new-id" }];
  outcome = "succeeded";
  const secondRun = app.chat.start(second.id, {
    requestId: randomUUID(),
    expectedRevision: second.revision,
    content: "再整理一下",
  }).run;
  await until(secondRun.id, "waiting_reconciliation");
  expect(effects).toBe(1);
  app.toolSystem.resolveUnknown(concern.id, {
    kind: "confirmed_not_executed",
    note: "已检查目标文件不存在",
    at: new Date().toISOString(),
  });
  await app.chat.resume(secondRun.id);
  await until(secondRun.id, "succeeded");
  expect(effects).toBe(2);
});
it("取消未知结果后仍可核对；正常 put 拒绝迟到执行修改", async () => {
  calls = [
    {
      id: "write",
      name: "write_file",
      arguments: JSON.stringify({
        path: join(root, "work", "target.txt"),
        content: "内容",
        expectedHash: null,
      }),
    },
  ];
  outcome = "unknown";
  const current = await session();
  const run = app.chat.start(current.id, {
    requestId: randomUUID(),
    expectedRevision: current.revision,
    content: "处理文件",
  }).run;
  await until(run.id, "waiting_reconciliation");
  await app.chat.cancel(run.id);
  const invocation = app.store.execution.list("invocations", {
    runId: run.id,
  })[0];
  if (!invocation) throw new Error("missing invocation");
  expect(() =>
    app.store.execution.put("invocations", {
      ...invocation,
      status: "succeeded",
    }),
  ).toThrow();
  const resolved = app.toolSystem.resolveUnknown(invocation.id, {
    kind: "confirmed_executed",
    note: "已核对文件内容",
    at: new Date().toISOString(),
  });
  expect(resolved.resolution?.kind).toBe("confirmed_executed");
  expect(app.store.execution.get("invocations", invocation.id)?.status).toBe(
    "unknown",
  );
});
it("恢复存在的可靠回执只补录事实，不再次派发；没有回执的已接受写操作保持未知", async () => {
  const current = await session();
  calls = [
    {
      id: "write",
      name: "write_file",
      arguments: JSON.stringify({
        path: join(root, "work", "file.txt"),
        content: "内容",
        expectedHash: null,
      }),
    },
  ];
  outcome = "unknown";
  const run = app.chat.start(current.id, {
    requestId: randomUUID(),
    expectedRevision: current.revision,
    content: "处理",
  }).run;
  await until(run.id, "waiting_reconciliation");
  const invocation = app.store.execution.list("invocations", {
    runId: run.id,
  })[0];
  const attempt = app.store.execution.list("attempts", { runId: run.id })[0];
  if (!invocation || !attempt) throw new Error("missing intent");
  invocation.status = "running";
  invocation.result = null;
  app.store.execution.put("invocations", invocation);
  attempt.status = "accepted";
  app.store.execution.put("attempts", attempt);
  app.store.execution.setRunStatus(run.id, "recoverable");
  app.gateway.reconcile = async () => ({
    attemptId: attempt.id,
    invocationId: invocation.id,
    outcome: "succeeded",
    data: { afterHash: "receipt-hash" },
    error: null,
    effectsPossible: true,
    completedAt: new Date().toISOString(),
  });
  await app.toolSystem.recover();
  expect(effects).toBe(1);
  expect(requests).toBe(1);
  expect(app.store.execution.get("invocations", invocation.id)?.status).toBe(
    "succeeded",
  );
  await app.chat.resume(run.id);
  await until(run.id, "succeeded");
  expect(effects).toBe(1);
  expect(requests).toBe(2);
});
it("等待审批期间仅累计运行时间，不以旧总时限取消任务或请求模型", async () => {
  const current = await session();
  const run = app.chat.start(current.id, {
    requestId: randomUUID(),
    expectedRevision: current.revision,
    content: "读取",
  }).run;
  await until(run.id, "waiting_approval");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const checkpoint = app.store.execution.get("checkpoints", run.id);
  if (!checkpoint) throw new Error("checkpoint");
  checkpoint.limits = Object.assign(
    { ...AGENT_LIMITS },
    { runTimeoutMs: 100, outputCharacters: 1 },
  );
  checkpoint.updatedAt = new Date(Date.now() - 200).toISOString();
  app.store.execution.put("checkpoints", checkpoint);
  app.store.execution.put("processes", {
    id: "process",
    sessionId: current.id,
    runId: run.id,
    invocationId: "invocation",
    workerId: "worker",
    pid: 123,
    status: "running",
    exitCode: null,
    signal: null,
    outputRef: "",
    createdAt: new Date().toISOString(),
    endedAt: null,
  });
  await app.chat.maintain();
  expect(app.store.getRun(run.id).status).toBe("waiting_approval");
  expect(
    app.store.execution.get("checkpoints", run.id)?.activeMilliseconds,
  ).toBeGreaterThanOrEqual(200);
  expect(requests).toBe(1);
});
it("结果保存失败停止新派发，不把可能已发生的写操作包装为未执行", async () => {
  calls = [
    {
      id: "write",
      name: "write_file",
      arguments: JSON.stringify({
        path: join(root, "work", "target.txt"),
        content: "内容",
        expectedHash: null,
      }),
    },
  ];
  const current = await session();
  app.toolSystem.options.results.save = async () => {
    throw new Error("disk full");
  };
  const run = app.chat.start(current.id, {
    requestId: randomUUID(),
    expectedRevision: current.revision,
    content: "保存",
  }).run;
  await until(run.id, "waiting_reconciliation");
  expect(effects).toBe(1);
  expect(requests).toBe(1);
  const invocation = app.store.execution.list("invocations", {
    runId: run.id,
  })[0];
  expect(invocation?.status).toBe("unknown");
  expect(invocation?.result?.error?.code).toBe("execution_storage");
});

it("自定义极小结果预算仍严格限制回传文字，不因截断说明突破容量", async () => {
  calls = [
    {
      id: "read",
      name: "read_file",
      arguments: JSON.stringify({ path: join(root, "work", "note.txt") }),
    },
  ];
  const current = await session();
  const run = app.chat.start(current.id, {
    requestId: randomUUID(),
    expectedRevision: current.revision,
    content: "读取说明",
  }).run;
  const checkpoint = app.store.execution.get("checkpoints", run.id);
  if (!checkpoint) throw new Error("checkpoint");
  checkpoint.limits.toolResultCharacters = 10;
  app.store.execution.put("checkpoints", checkpoint);
  await until(run.id, "succeeded");
  const result = app.store.execution.list("invocations", { runId: run.id })[0]
    ?.result;
  expect(result?.truncated).toBe(true);
  expect(result?.modelContent.length).toBeLessThanOrEqual(10);
  expect(result?.resultRef).toBeTruthy();
});

/** 没有活动 launch 协程的审批暂停也必须正确收尾 Trace，不能依赖生成循环的 finally。 */
it("取消审批暂停的 Run 关闭追踪且不派发业务动作", async () => {
  const current = await session();
  const run = app.chat.start(current.id, {
    requestId: randomUUID(),
    expectedRevision: current.revision,
    content: "读取外部资料",
  }).run;
  await until(run.id, "waiting_approval");
  await expect.poll(() => app.chat.executing(run.id)).toBe(false);
  await app.chat.cancel(run.id);
  expect(app.store.getRun(run.id).status).toBe("cancelled");
  const traces = app.observations.traces({ runId: run.id }).items;
  expect(traces).toHaveLength(1);
  expect(traces[0]?.status).toBe("cancelled");
  expect(effects).toBe(0);
  expect(
    app.store.execution
      .list("approvals", { runId: run.id })
      .every((a) => a.status === "cancelled"),
  ).toBe(true);
});
