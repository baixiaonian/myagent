/** 双协议团队验收：官方 SDK 访问真实 loopback HTTP，成员再次走同一 Responses/Chat 模型适配器。 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import { isActiveRun } from "../../packages/contracts/src/index.js";
import { mockProvider } from "../chat/provider.js";

it.each(["responses", "chat_completions"] as const)(
  "%s completes member tools then joins the final answer",
  async (protocol) => {
    const dir = mkdtempSync(join(tmpdir(), "myagent-teams-http-"));
    const provider = await mockProvider(0, (question, results) => {
      if (question === "团队HTTP验收")
        return results.length
          ? { calls: [], text: "最终汇总" }
          : {
              text: "分配独立分析。",
              calls: [
                {
                  id: "create-member",
                  name: "spawn_agent",
                  arguments: JSON.stringify({
                    name: "分析员",
                    instructions: "独立核验",
                    task: "成员HTTP任务",
                  }),
                },
              ],
            };
      if (question === "成员HTTP任务")
        return results.length
          ? { calls: [], text: "成员读取真实时间完成" }
          : {
              text: "",
              calls: [
                {
                  id: "member-time",
                  name: "get_current_time",
                  arguments: "{}",
                },
              ],
            };
      return null;
    });
    const app = await buildServer({ dataDir: dir, serveWeb: false });
    try {
      app.settings.save({
        apiProtocol: protocol,
        baseUrl: provider.url,
        model: "test",
        apiKey: "fixture",
        systemPrompt: "",
        expectedRevision: 0,
      });
      const s = app.store.createSession();
      const r = app.chat.start(s.id, {
        requestId: randomUUID(),
        expectedRevision: 0,
        content: "团队HTTP验收",
      }).run;
      await expect
        .poll(() => isActiveRun(app.store.getRun(r.id).status), {
          timeout: 10000,
        })
        .toBe(false);
      expect(app.store.getRun(r.id).status).toBe("succeeded");
      const team = app.teams.view(s.id);
      expect(team.members).toHaveLength(1);
      expect(team.members[0]?.runStatus).toBe("succeeded");
      expect(provider.requests.length).toBeGreaterThanOrEqual(5);
      const m = team.members[0]!;
      expect(
        app.store.snapshot(m.internalSessionId).messages[0]?.origin?.kind,
      ).toBe("agent");
      expect(app.store.getRun(m.runId!).apiProtocol).toBe(protocol);
      expect(app.store.getSteps(m.runId!)[0]?.step.tools[0]?.name).toBe(
        "get_current_time",
      );
      expect(JSON.stringify(team)).not.toContain("private-reasoning-fixture");
      expect(team.usage).toBeNull();
      // 观测只按实际 HTTP 叶子请求记账，主/成员共享 Trace，成员身份不能串到主分支。
      const calls = app.observations.calls({ runId: r.id });
      expect(calls).toHaveLength(provider.requests.length);
      expect(new Set(calls.map((c) => c.traceId)).size).toBe(1);
      expect(calls.some((c) => c.scope.agentId === m.id)).toBe(true);
      expect(calls.some((c) => c.scope.agentId === "main")).toBe(true);
      expect(app.observations.runSummary(r.id).usage.requests).toBe(
        provider.requests.length,
      );
      const spans = app.observations.store.list("spans");
      expect(
        spans.some(
          (s) => s.name === "team.message.included" && s.links.length > 0,
        ),
      ).toBe(true);
      expect(JSON.stringify(spans)).not.toContain("private-reasoning-fixture");
    } finally {
      await app.server.close();
      await provider.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
