/** 团队故障与治理验收：消息身份、上下文边界、停止/重启/候选分支都使用真实 SQLite，模型为可控替身。 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import {
  isActiveRun,
  type JsonValue,
  type ToolCall,
} from "../../packages/contracts/src/index.js";
import type {
  ModelMessage,
  ModelPort,
} from "../../packages/kernel/src/index.js";

let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
const workspaces: string[] = [];
const call = (name: string, args: unknown): ToolCall => ({
  id: randomUUID(),
  name,
  arguments: JSON.stringify(args),
});
const role = (messages: readonly ModelMessage[]) =>
  messages.some((m) => m.content.includes("角色说明：成员"))
    ? "member"
    : "main";
async function setup(model: ModelPort, limits = {}) {
  dir = mkdtempSync(join(tmpdir(), "myagent-team-recovery-"));
  app = await buildServer({
    dataDir: dir,
    serveWeb: false,
    modelFactory: () => model,
    agentLimits: limits,
  });
  app.settings.save({
    apiProtocol: "responses",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    apiKey: "fixture",
    systemPrompt: "",
    expectedRevision: 0,
  });
  return app.store.createSession();
}
afterEach(async () => {
  if (app) await app.server.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const workspace of workspaces.splice(0))
    rmSync(workspace, { recursive: true, force: true });
});
async function end(id: string) {
  await expect
    .poll(() => isActiveRun(app.store.getRun(id).status), { timeout: 10000 })
    .toBe(false);
  return app.store.getRun(id);
}
function scripted(
  fn: (
    messages: readonly ModelMessage[],
    signal: AbortSignal,
  ) =>
    | Promise<{ text?: string; calls?: ToolCall[] }>
    | { text?: string; calls?: ToolCall[] },
): ModelPort {
  return {
    async *stream(messages, signal) {
      const data = await fn(messages, signal);
      const text = data.text ?? "";
      if (text) yield { type: "text", text };
      yield {
        type: "done",
        finishReason: data.calls?.length ? "tool_calls" : "stop",
        usage: null,
        response: { content: text, toolCalls: data.calls ?? [] },
      };
    },
  };
}
const hanging = (signal: AbortSignal) =>
  new Promise<{ text: string }>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
    if (signal.aborted) reject(signal.reason);
    void resolve;
  });
it("stopping the main run cancels real member requests, closes waiting and retains histories", async () => {
  let spawned = false;
  const s = await setup(
    scripted((messages, signal) => {
      if (role(messages) === "member") return hanging(signal);
      if (!spawned) {
        spawned = true;
        return {
          calls: [
            call("spawn_agent", {
              name: "助手",
              instructions: "成员",
              task: "持续分析",
            }),
          ],
        };
      }
      return { text: "候选回答" };
    }),
  );
  const run = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "团队测试",
  }).run;
  await expect
    .poll(() => app.teams.view(s.id).members[0]?.runStatus)
    .toBe("running");
  const member = app.teams.view(s.id).members[0]!;
  expect(() =>
    app.chat.start(member.internalSessionId, {
      requestId: randomUUID(),
      expectedRevision: 0,
      content: "绕过主对话",
    }),
  ).toThrow("主对话");
  await app.chat.cancel(run.id);
  expect((await end(run.id)).status).toBe("cancelled");
  expect(isActiveRun(app.store.getRun(member.runId!).status)).toBe(false);
  expect(app.teams.view(s.id).members).toHaveLength(1);
  expect(app.store.listSessions()).toHaveLength(1);
  expect(
    app.observations
      .traces({ runId: run.id })
      .items.every((trace) => trace.status !== "running"),
  ).toBe(true);
});
it("restart does not dispatch; explicit main resume restores children without creating duplicate members", async () => {
  let count = 0,
    spawned = false,
    allow = false;
  const model = scripted((messages, signal) => {
    count++;
    if (role(messages) === "member")
      return allow ? { text: "恢复后的成果" } : hanging(signal);
    if (!spawned) {
      spawned = true;
      return {
        calls: [
          call("spawn_agent", {
            name: "助手",
            instructions: "成员",
            task: "分析",
          }),
        ],
      };
    }
    return { text: "汇总" };
  });
  const s = await setup(model);
  const run = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "团队测试",
  }).run;
  await expect
    .poll(() => app.store.getRun(run.id).status)
    .toBe("waiting_agents");
  await app.server.close();
  const before = count;
  allow = true;
  app = await buildServer({
    dataDir: dir,
    serveWeb: false,
    modelFactory: () => model,
  });
  await app.teams.maintain();
  expect(count).toBe(before);
  await app.chat.resume(run.id);
  await app.teams.maintain();
  expect((await end(run.id)).status).toBe("succeeded");
  expect(app.teams.view(s.id).members).toHaveLength(1);
}, 20000);
it("members cannot spawn, stop peers or modify memory, and cannot inspect unshared parent messages", async () => {
  let spawned = false;
  const s = await setup(
    scripted((messages, signal) => {
      if (role(messages) === "member") return hanging(signal);
      if (!spawned) {
        spawned = true;
        return {
          calls: [
            call("spawn_agent", {
              name: "助手",
              instructions: "成员",
              task: "分析",
            }),
          ],
        };
      }
      return { text: "汇总" };
    }),
  );
  const run = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "用户秘密约束",
  }).run;
  await expect.poll(() => app.teams.view(s.id).members[0]?.runId).toBeTruthy();
  const m = app.teams.view(s.id).members[0]!;
  expect(app.teams.allowed(m.runId!, "spawn_agent")).toBe(false);
  expect(app.teams.allowed(m.runId!, "stop_agent")).toBe(false);
  expect(app.teams.allowed(m.runId!, "update_memory")).toBe(false);
  const stranger = app.store.createSession();
  expect(() => app.teams.history(stranger.id, m.id)).toThrow();
  expect(
    JSON.stringify(app.teams.history(s.id, "main", "0:0", m.id)),
  ).toContain("用户秘密约束");
  expect(
    app.memories.sessionSettings(m.internalSessionId).contributeMemories,
  ).toBe(false);
  await app.chat.cancel(run.id);
});
it("failed candidate keeps original team, and successful new task can reuse original identity", async () => {
  let phase = 0,
    spawned = false;
  const s = await setup(
    scripted((messages) => {
      if (role(messages) === "member") return { text: "成员完成" };
      if (phase === 1) throw new Error("controlled failure");
      if (!spawned) {
        spawned = true;
        return {
          calls: [
            call("spawn_agent", {
              name: "助手",
              instructions: "成员",
              task: "分析",
            }),
          ],
        };
      }
      return { text: "原始成果" };
    }),
  );
  const run = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "团队测试",
  }).run;
  expect((await end(run.id)).status).toBe("succeeded");
  const id = app.teams.view(s.id).members[0]!.id;
  phase = 1;
  const retry = app.chat.start(
    s.id,
    {
      requestId: randomUUID(),
      expectedRevision: app.store.snapshot(s.id).session.revision,
    },
    "regenerate",
  ).run;
  expect((await end(retry.id)).status).toBe("failed");
  expect(app.teams.view(s.id).members[0]!.id).toBe(id);
  phase = 2;
  const next = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: app.store.snapshot(s.id).session.revision,
    content: "继续",
  }).run;
  await end(next.id);
  expect(app.teams.view(s.id).members[0]!.id).toBe(id);
});
it("member creation with the same logical invocation rolls back on receipt failure", async () => {
  const s = await setup(scripted((_m, signal) => hanging(signal)));
  const run = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "团队测试",
  }).run;
  const id = randomUUID(),
    args = { name: "助手", instructions: "成员", task: "分析" };
  await expect(
    app.teams.execute(
      run.id,
      id,
      "spawn_agent",
      args,
      new AbortController().signal,
      () => {
        throw new Error("disk failure");
      },
    ),
  ).rejects.toThrow("disk failure");
  expect(app.teams.view(s.id).members).toHaveLength(0);
  let result: JsonValue = null;
  await app.teams.execute(
    run.id,
    id,
    "spawn_agent",
    args,
    new AbortController().signal,
    (v) => {
      result = v;
    },
  );
  const first = result;
  await app.teams.execute(
    run.id,
    id,
    "spawn_agent",
    args,
    new AbortController().signal,
    (v) => {
      result = v;
    },
  );
  expect(result).toEqual(first);
  expect(app.teams.view(s.id).members).toHaveLength(1);
  await expect(
    app.teams.execute(
      run.id,
      id,
      "spawn_agent",
      { ...args, name: "不同" },
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await app.chat.cancel(run.id);
});
it("context selection preserves complete turns and omits failed answers and private continuation", async () => {
  let stage = 0;
  const observed: string[] = [];
  const s = await setup(
    scripted((messages) => {
      if (role(messages) === "member") {
        observed.push(JSON.stringify(messages));
        return { text: "成员完成" };
      }
      if (stage++ === 0) return { text: "上一轮可靠答案" };
      if (stage === 2)
        return {
          calls: [
            call("spawn_agent", {
              name: "助手",
              instructions: "成员",
              task: "分析",
              context: { mode: "recent", turns: 1 },
            }),
          ],
        };
      return { text: "汇总" };
    }),
  );
  const first = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "上一轮问题",
  }).run;
  await end(first.id);
  const next = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: app.store.snapshot(s.id).session.revision,
    content: "当前问题",
  }).run;
  await end(next.id);
  expect(observed[0]).toContain("上一轮问题");
  expect(observed[0]).toContain("上一轮可靠答案");
  expect(observed[0]).toContain("当前问题");
  expect(observed[0]).not.toContain("credentialRef");
});
it("累计产出与时长超过旧阈值后仍能创建成员、通信并由主 Agent 交付", async () => {
  let spawned = false;
  const s = await setup(
    scripted((messages) => {
      if (role(messages) === "member") return { text: "成员完成" };
      if (!spawned) {
        spawned = true;
        return {
          calls: [
            call("spawn_agent", {
              name: "长任务成员",
              instructions: "成员",
              task: "继续分析",
            }),
          ],
        };
      }
      return { text: "主任务已整合交付" };
    }),
  );
  const run = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "长任务",
  }).run;
  const scope = app.teams.scope(run.id);
  // 用旧持久状态模拟已运行十分钟且超过20万字符，避免真的等待十分钟。
  Object.assign(scope, {
    output: 201079,
    outputLimit: 200000,
    elapsed: 700000,
    timeLimit: 600000,
  });
  app.teams.store.put("scopes", scope);
  await app.teams.maintain();
  expect((await end(run.id)).status).toBe("succeeded");
  expect(app.teams.scope(run.id).output).toBeGreaterThan(201079);
  expect(app.teams.view(s.id).members).toHaveLength(1);
  expect(
    app.teams.store
      .list("messages")
      .some((m) => m.kind === "result" && m.to === "main"),
  ).toBe(true);
  expect(app.store.snapshot(s.id).messages.at(-1)?.content).toBe(
    "主任务已整合交付",
  );
});

it("closing an idle member releases capacity without deleting saved history", async () => {
  let spawned = false;
  const s = await setup(
    scripted((messages) => {
      if (role(messages) === "member") return { text: "完成" };
      if (!spawned) {
        spawned = true;
        return {
          calls: [
            call("spawn_agent", {
              name: "助手",
              instructions: "成员",
              task: "分析",
            }),
          ],
        };
      }
      return { text: "汇总" };
    }),
  );
  const r = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "团队测试",
  }).run;
  await end(r.id);
  const member = app.teams.view(s.id).members[0]!;
  const input = {
    requestId: randomUUID(),
    expectedRevision: member.revision,
    close: true,
  };
  await app.teams.stop(s.id, member.id, input);
  await app.teams.stop(s.id, member.id, input);
  expect(app.teams.view(s.id).members[0]?.status).toBe("closed");
  expect(app.teams.history(s.id, member.id).records.length).toBeGreaterThan(0);
  await app.chat.deleteSession(s.id);
  expect(app.store.listSessions()).toEqual([]);
  expect(app.store.teams.list("members")).toEqual([]);
});
it("wait_agents pauses without occupying the shared tool semaphore", async () => {
  let stage = 0;
  const s = await setup(
    scripted(async (messages) => {
      if (role(messages) === "member") {
        await new Promise((r) => setTimeout(r, 300));
        return { text: "完成" };
      }
      if (stage++ === 0)
        return {
          calls: [
            call("spawn_agent", {
              name: "助手",
              instructions: "成员",
              task: "分析",
            }),
          ],
        };
      if (stage === 2) return { calls: [call("wait_agents", {})] };
      return { text: "汇总" };
    }),
  );
  const { vi } = await import("vitest");
  const slots = vi.spyOn(app.toolSystem.options.coordinator!.slots, "use");
  const r = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "团队测试",
  }).run;
  await expect.poll(() => app.store.getRun(r.id).status).toBe("waiting_agents");
  expect(slots).not.toHaveBeenCalled();
  expect((await end(r.id)).status).toBe("succeeded");
  expect(
    app.store.execution
      .list("invocations", { runId: r.id })
      .find((i) => i.toolName === "wait_agents")?.result?.ok,
  ).toBe(true);
});
it("invalid parameters return a tool error and do not create members", async () => {
  let n = 0;
  const s = await setup(
    scripted(() =>
      n++ === 0
        ? { calls: [call("spawn_agent", { name: "缺少参数" })] }
        : { text: "改为直接回答" },
    ),
  );
  const r = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "团队测试",
  }).run;
  await end(r.id);
  expect(app.teams.view(s.id).members).toEqual([]);
  expect(app.store.getSteps(r.id)[0]?.step.tools[0]?.result?.error?.code).toBe(
    "invalid_tool_arguments",
  );
});
it("connection settings are frozen for members, and explicit request wakes an idle member", async () => {
  let stage = 0,
    memberCalls = 0;
  const s = await setup(
    scripted((messages) => {
      if (role(messages) === "member") {
        memberCalls++;
        return { text: "完成" };
      }
      if (stage++ === 0)
        return {
          calls: [
            call("spawn_agent", {
              name: "助手",
              instructions: "成员",
              task: "分析",
            }),
          ],
        };
      return { text: "汇总" };
    }),
  );
  const r = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "团队测试",
  }).run;
  app.settings.save({
    baseUrl: "http://127.0.0.1:2/v1",
    model: "new-model",
    apiProtocol: "chat_completions",
    systemPrompt: "新提示词",
    expectedRevision: app.settings.get().revision,
  });
  await end(r.id);
  const member = app.teams.view(s.id).members[0]!;
  expect(app.store.getRun(member.runId!).model).toBe("fixture");
  expect(app.store.getRun(member.runId!).apiProtocol).toBe("responses");
  const before = memberCalls;
  await app.teams.maintain();
  expect(memberCalls).toBe(before);
});
it("member resource approval remains once-only, and delegated side effects require regenerate confirmation", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  let phase = 0;
  let outside = "";
  const s = await setup(
    scripted((messages) => {
      if (role(messages) === "member")
        return messages.filter((m) => m.role === "tool").length >= 2
          ? { text: "完成" }
          : {
              calls: [
                call("write_file", {
                  path: outside,
                  content: "新资料",
                  expectedHash: null,
                }),
              ],
            };
      if (phase++ === 0)
        return {
          calls: [
            call("spawn_agent", {
              name: "助手",
              instructions: "成员",
              task: "保存外部资料",
            }),
          ],
        };
      return { text: "汇总" };
    }),
  );
  // 这里只替换底层回执，验证真实参数/资源审批/事务；OS 隔离由 native 专项单独验证。
  const base = mkdtempSync(join(tmpdir(), "myagent-team-resources-"));
  workspaces.push(base);
  const work = join(base, "work");
  mkdirSync(work);
  outside = join(base, "outside.txt");
  writeFileSync(outside, "外部资料");
  const workspace = await app.toolSystem.createWorkspace(work, "测试项目");
  app.store.execution.bindWorkspace(s.id, workspace.id, 0);
  let dispatched = 0;
  app.toolSystem.options.gateway.dispatch = async (request) => {
    dispatched++;
    return {
      attemptId: request.attemptId,
      invocationId: request.context.invocationId,
      outcome: "succeeded",
      data: { text: "外部资料" },
      error: null,
      effectsPossible: true,
      completedAt: new Date().toISOString(),
    };
  };
  const r = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: app.store.snapshot(s.id).session.revision,
    content: "团队测试",
  }).run;
  await expect
    .poll(() => app.teams.view(s.id).members[0]?.runStatus)
    .toBe("waiting_approval");
  expect(dispatched).toBe(0);
  const member = app.teams.view(s.id).members[0]!;
  const approval = app.toolSystem.overview(member.internalSessionId)
    .approvals[0]!;
  app.toolSystem.decide(approval.id, {
    requestId: randomUUID(),
    decision: "allow",
    scope: "once",
  });
  await app.chat.resume(member.runId!);
  await expect
    .poll(
      () =>
        app.toolSystem
          .overview(member.internalSessionId)
          .approvals.filter((a) => a.status === "pending").length,
    )
    .toBe(1);
  expect(dispatched).toBe(1);
  const next = app.toolSystem
    .overview(member.internalSessionId)
    .approvals.find((a) => a.status === "pending")!;
  expect(next.id).not.toBe(approval.id);
  app.toolSystem.decide(next.id, {
    requestId: randomUUID(),
    decision: "allow",
    scope: "once",
  });
  await app.chat.resume(member.runId!);
  expect((await end(r.id)).status).toBe("succeeded");
  expect(dispatched).toBe(2);
  const traces = app.observations.traces({ runId: r.id }).items;
  expect(traces).toHaveLength(1);
  expect(traces[0]?.status).toBe("succeeded");
  expect(
    app.observations.store
      .list("spans", { traceId: traces[0]!.id })
      .filter((span) => !span.endedAt),
  ).toEqual([]);
  // 副作用回执由真实工具事务保存；测试网关不执行文件修改，native 另验真实写入。

  expect(() =>
    app.chat.start(
      s.id,
      {
        requestId: randomUUID(),
        expectedRevision: app.store.snapshot(s.id).session.revision,
      },
      "regenerate",
    ),
  ).toThrow("旧操作不会自动撤销");
});
it.each(["standard", "full_access"] as const)(
  "members inherit %s and keep project-rule and extension snapshots",
  async (executionMode) => {
    const { writeFileSync } = await import("node:fs");
    let stage = 0;
    const s = await setup(
      scripted((messages) =>
        role(messages) === "member"
          ? { text: "完成" }
          : stage++ === 0
            ? {
                calls: [
                  call("spawn_agent", {
                    name: "助手",
                    instructions: "成员",
                    task: "遵守项目约定",
                  }),
                ],
              }
            : { text: "汇总" },
      ),
    );
    const work = mkdtempSync(join(tmpdir(), "myagent-team-rules-"));
    workspaces.push(work);
    writeFileSync(join(work, "AGENTS.md"), "规则 A：使用中文报告");
    const workspace = await app.toolSystem.createWorkspace(work, "规则项目");
    app.store.execution.bindWorkspace(s.id, workspace.id, 0);
    const r = app.chat.start(s.id, {
      requestId: randomUUID(),
      expectedRevision: app.store.snapshot(s.id).session.revision,
      content: "协作",
      executionMode,
    }).run;
    // 根 Run 已同步冻结；下一次成员启动不得重新读取修改后的文件。
    writeFileSync(join(work, "AGENTS.md"), "规则 B：已被外部编辑");
    await end(r.id);
    const memberRun = app.teams.view(s.id).members[0]!.runId!;
    expect(app.store.getRun(memberRun).executionMode).toBe(executionMode);
    const root = app.contexts.store.get("runs", r.id)!,
      child = app.contexts.store.get("runs", memberRun)!;
    expect(child.rules).toBe("规则 A：使用中文报告");
    expect(child.view.ruleSource).toEqual(root.view.ruleSource);
    expect(app.hooks.store.get("runs", memberRun)?.hooks).toEqual(
      app.hooks.store.get("runs", r.id)?.hooks,
    );
    expect(app.plugins.store.get("runs", memberRun)?.references).toEqual(
      app.plugins.store.get("runs", r.id)?.references,
    );
  },
);
it("deleting an active root cancels members and rejects late starts without resurrecting histories", async () => {
  let spawned = false,
    memberCalls = 0;
  const s = await setup(
    scripted((messages, signal) => {
      if (role(messages) === "member") {
        memberCalls++;
        return hanging(signal);
      }
      if (!spawned) {
        spawned = true;
        return {
          calls: [
            call("spawn_agent", {
              name: "助手",
              instructions: "成员",
              task: "分析",
            }),
          ],
        };
      }
      return { text: "汇总" };
    }),
  );
  app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "团队测试",
  });
  await expect.poll(() => memberCalls).toBe(1);
  await app.chat.deleteSession(s.id);
  await app.teams.maintain();
  expect(app.store.teams.list("members")).toEqual([]);
  expect(app.store.listSessions()).toEqual([]);
  expect(memberCalls).toBe(1);
});

it("持锁成员不能进入事件等待或提前收尾；释放后事件唤醒且等待期间无模型轮询", async () => {
  let stage = 0;
  let rootRun = "";
  let unlock = () => {};
  let finishMember = () => {};
  const memberDone = new Promise<void>((resolve) => {
    finishMember = resolve;
  });
  const s = await setup(
    scripted(async (messages) => {
      if (role(messages) === "member") {
        await memberDone;
        return { text: "成员报告已完成" };
      }
      stage++;
      if (stage === 1)
        return {
          calls: [
            call("spawn_agent", {
              name: "报告员",
              instructions: "成员",
              task: "写报告",
            }),
          ],
        };
      if (stage === 2) {
        const coordinator = app.toolSystem.options.coordinator!;
        const keys = [{ key: "path:/fixture/project", mode: "write" as const }];
        unlock = coordinator.retainProcess(
          rootRun,
          "poll-process",
          keys,
          await coordinator.acquire(
            rootRun,
            keys,
            new AbortController().signal,
          ),
        );
        return { calls: [call("wait_agents", { timeoutMs: 120000 })] };
      }
      if (stage === 3) {
        expect(
          messages.some(
            (m) => m.role === "tool" && m.content.includes("poll-process"),
          ),
        ).toBe(true);
        return { text: "尝试结束，但成员尚未完成" };
      }
      if (stage === 4) {
        expect(messages.at(-1)?.content).toContain("poll-process");
        unlock();
        return { calls: [call("wait_agents", { timeoutMs: 120000 })] };
      }
      return { text: "已经整合成员报告" };
    }),
  );
  const run = app.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "团队报告",
  }).run;
  rootRun = run.id;
  try {
    await expect
      .poll(() => app.store.getRun(run.id).status)
      .toBe("waiting_agents");
    const waitingStage = stage;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stage).toBe(waitingStage);
    expect(stage).toBe(4);
    finishMember();
    expect((await end(run.id)).status).toBe("succeeded");
    const waits = app.store.execution
      .list("invocations", { runId: run.id })
      .filter((i) => i.toolName === "wait_agents");
    expect(waits.map((i) => i.result?.error?.code ?? "ok")).toEqual([
      "agent_wait_resource_conflict",
      "ok",
    ]);
  } finally {
    unlock();
    finishMember();
  }
});
