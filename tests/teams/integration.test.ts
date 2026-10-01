/** 团队集成验收：独立临时实例与协议中立替身，验证真实仓储、工具派发和原循环；不冒充真实模型验收。 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import {
  isActiveRun,
  type ToolCall,
} from "../../packages/contracts/src/index.js";
import type { ModelPort } from "../../packages/kernel/src/index.js";

let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let dir = "";
afterEach(async () => {
  await app?.server.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
const call = (name: string, args: unknown): ToolCall => ({
  id: randomUUID(),
  name,
  arguments: JSON.stringify(args),
});
async function setup(model: ModelPort) {
  dir = mkdtempSync(join(tmpdir(), "myagent-teams-"));
  app = await buildServer({
    dataDir: dir,
    serveWeb: false,
    modelFactory: () => model,
  });
  app.settings.save({
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    apiProtocol: "responses",
    apiKey: "fixture-key",
    systemPrompt: "",
    expectedRevision: app.settings.get().revision,
  });
  return app;
}
async function done(id: string) {
  await expect
    .poll(() => app!.store.getRun(id).status, { timeout: 15000 })
    .not.toSatisfy((s: string) =>
      isActiveRun(s as Parameters<typeof isActiveRun>[0]),
    );
  return app!.store.getRun(id);
}
it("main works, members communicate directly, final joins and identity survives next user turn", async () => {
  const counts = new Map<string, number>();
  const model: ModelPort = {
    async *stream(messages) {
      const text = messages.map((m) => m.content).join("\n");
      const actor = text.includes("角色说明：角色A")
        ? "A"
        : text.includes("角色说明：角色B")
          ? "B"
          : "main";
      const n = (counts.get(actor) ?? 0) + 1;
      counts.set(actor, n);
      let tools: ToolCall[] = [];
      let answer = "";
      if (actor === "main" && n === 1)
        tools = [
          call("spawn_agent", {
            name: "分析员A",
            instructions: "角色A",
            task: "分析任务A",
          }),
          call("spawn_agent", {
            name: "开发员B",
            instructions: "角色B",
            task: "实现任务B",
          }),
        ];
      else if (actor === "main" && n === 2)
        tools = [call("get_current_time", {})];
      else if (actor === "main" && n === 3)
        answer = "先形成候选，等待团队成果。";
      else if (actor === "main")
        answer = "汇总完成：我已参与分析并整合团队结果。";
      else if (actor === "A" && n === 1) tools = [call("list_agents", {})];
      else if (actor === "A" && n === 2) {
        const b = app!.teams
          .view(app!.store.listSessions()[0]!.id)
          .members.find((m) => m.name === "开发员B")!;
        tools = [
          call("send_message", {
            agentId: b.id,
            content: "请确认字段名称。",
            kind: "request",
          }),
        ];
      } else if (actor === "B" && n === 1) {
        await new Promise((r) => setTimeout(r, 150));
        answer = "初步结果B";
      } else if (actor === "B" && n === 2) {
        const a = app!.teams
          .view(app!.store.listSessions()[0]!.id)
          .members.find((m) => m.name === "分析员A")!;
        tools = [
          call("send_message", {
            agentId: a.id,
            content: "字段是 amount，供你继续分析。",
            kind: "inform",
          }),
        ];
      } else answer = `${actor} 工作完成`;
      if (answer) yield { type: "text", text: answer };
      yield {
        type: "done",
        finishReason: tools.length ? "tool_calls" : "stop",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        response: { content: answer, toolCalls: tools },
      };
    },
  };
  const a = await setup(model);
  const s = a.store.createSession();
  const input = {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "请协作分析和实现，我希望你自己也参与。",
  };
  const run = a.chat.start(s.id, input).run;
  expect(a.chat.start(s.id, input).run.id).toBe(run.id);

  expect((await done(run.id)).status).toBe("succeeded");
  const team = a.teams.view(s.id);
  expect(team.members).toHaveLength(2);
  expect(team.usage?.totalTokens).toBe(
    [...counts.values()].reduce((sum, n) => sum + n, 0) * 15,
  );
  for (const member of team.members)
    expect(member.usage?.totalTokens).toBe(
      (counts.get(member.name === "分析员A" ? "A" : "B") ?? 0) * 15,
    );
  expect(team.members.every((m) => m.status === "idle")).toBe(true);
  expect(a.store.listSessions()).toHaveLength(1);
  const messages = a.teams.messages(s.id).items;
  expect(
    messages.some(
      (m) => m.from !== "main" && m.to !== "main" && m.content.includes("字段"),
    ),
  ).toBe(true);
  expect(a.store.snapshot(s.id).messages.at(-1)?.content).toContain("汇总完成");
  expect(
    a.store
      .events(s.id, 0)
      .some((e) => e.type === "team.updated" && e.schemaVersion === 6),
  ).toBe(true);
  expect(
    a.teams
      .history(s.id, team.members[1]!.id, "0:0", team.members[0]!.id)
      .records.join(""),
  ).not.toContain("fixture-key");
  const second = a.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: a.store.snapshot(s.id).session.revision,
    content: "继续讨论",
  }).run;
  expect((await done(second.id)).status).toBe("succeeded");
  expect(a.teams.view(s.id).members.map((m) => m.id)).toEqual(
    team.members.map((m) => m.id),
  );
}, 30000);
it("ordinary answers use one request and create no members", async () => {
  let requests = 0;
  const a = await setup({
    async *stream() {
      requests++;
      yield { type: "text", text: "你好" };
      yield {
        type: "done",
        finishReason: "stop",
        usage: null,
        response: { content: "你好", toolCalls: [] },
      };
    },
  });
  const s = a.store.createSession();
  const r = a.chat.start(s.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    content: "你好",
  }).run;
  expect((await done(r.id)).status).toBe("succeeded");
  expect(requests).toBe(1);
  expect(a.teams.view(s.id).members).toEqual([]);
});
