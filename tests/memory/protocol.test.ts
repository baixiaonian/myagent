/** 双协议记忆闭环：使用本地真实 HTTP 流，覆盖对话记住、跨会话检索、后台无工具提炼及敏感边界。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import { isActiveRun } from "../../packages/contracts/src/index.js";
import { mockProvider } from "../chat/provider.js";

it.each(["responses", "chat_completions"] as const)(
  "%s 对话工具和两阶段提炼实际 HTTP 闭环",
  async (protocol) => {
    const fixture = await mockProvider(0, (question, results) => {
      try {
        const data = JSON.parse(question);
        if (Array.isArray(data))
          return {
            calls: [],
            text: JSON.stringify({
              memories: [
                {
                  title: "归档代码",
                  text: "验收项目归档代码为 NOVA-77。",
                  kind: "project",
                  projectSpecific: false,
                  sourceIndexes: [0],
                },
              ],
            }),
          };
        if (data.candidates)
          return {
            calls: [],
            text: JSON.stringify({
              actions: data.candidates.map(
                (c: {
                  candidateIndex: number;
                  title: string;
                  text: string;
                }) => ({ ...c, action: "add" }),
              ),
            }),
          };
      } catch {
        /* 普通聊天不是 JSON；后续按自然语言场景提供受控的协议返回。 */
      }
      if (question.includes("请记住"))
        return {
          calls: results.length
            ? []
            : [
                {
                  id: "remember",
                  name: "update_memory",
                  arguments: JSON.stringify({
                    action: "add",
                    title: "验收偏好",
                    text: "用户偏好以中文简短回答。",
                    kind: "preference",
                  }),
                },
              ],
          text: results.length ? "已保存偏好。" : "",
        };
      if (question.includes("找回偏好")) {
        if (!results.length)
          return {
            calls: [
              {
                id: "search",
                name: "search_memories",
                arguments: JSON.stringify({ query: "偏好" }),
              },
            ],
            text: "",
          };
        const found = JSON.parse(results[0]!.content);
        // 工具结果为执行系统标准包，真实 tool 内容由 loop 提供而不是直接注入答案。
        const data = found.data ?? found;
        if (results.length === 1)
          return {
            calls: [
              {
                id: "read",
                name: "read_memory",
                arguments: JSON.stringify({ id: data.entries[0].id }),
              },
            ],
            text: "",
          };
        return { calls: [], text: "已查阅记忆：用户偏好中文简短回答。" };
      }
      if (question.includes("忘掉偏好")) {
        if (!results.length)
          return {
            calls: [
              {
                id: "find",
                name: "search_memories",
                arguments: '{"query":"验收偏好"}',
              },
            ],
            text: "",
          };
        if (results.length === 1) {
          const value = JSON.parse(results[0]!.content);
          const e = (value.data ?? value).entries[0];
          return {
            calls: [
              {
                id: "forget",
                name: "update_memory",
                arguments: JSON.stringify({
                  action: "forget",
                  id: e.id,
                  expectedRevision: e.revision,
                }),
              },
            ],
            text: "",
          };
        }
        return { calls: [], text: "已忘记。" };
      }
      return { calls: [], text: "已确认归档代码 NOVA-77。" };
    });
    const dir = mkdtempSync(join(tmpdir(), "myagent-memory-protocol-"));
    const app = await buildServer({ dataDir: dir, serveWeb: false });
    try {
      app.settings.save({
        apiProtocol: protocol,
        baseUrl: fixture.url,
        model: "test",
        apiKey: "sk-memory-fixture-secret",
        systemPrompt: "",
        expectedRevision: 0,
      });
      const settings = app.memories.settings();
      app.memories.saveSettings({
        ...settings,
        enabled: true,
        expectedRevision: settings.revision,
      });
      async function run(id: string, content: string) {
        const a = app.chat.start(id, {
          requestId: crypto.randomUUID(),
          expectedRevision: app.store.snapshot(id).session.revision,
          content,
        });
        for (let i = 0; i < 300; i++) {
          const r = app.store.getRun(a.run.id);
          if (!isActiveRun(r.status)) {
            expect(r.status, r.error?.message).toBe("succeeded");
            return r;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw Error("run timeout");
      }
      const first = await app.projects.create({
        requestId: crypto.randomUUID(),
      });
      await run(first.id, "请记住，我偏好中文简短回答。");
      expect(app.memories.entries()).toHaveLength(1);
      const second = await app.projects.create({
        requestId: crypto.randomUUID(),
      });
      const result = await run(
        second.id,
        "找回偏好，查一下我之前保存的表达习惯。",
      );
      expect(result.stepCount).toBe(3);
      const questionRequest = fixture.requests.find((r) =>
        r.messages.some((m) => m.content.includes("找回偏好")),
      );
      expect(JSON.stringify(questionRequest)).toContain("长期记忆资料");
      const job = await app.memories.jobs.create(first.id, "protocol-job");
      app.memories.jobs.kick();
      for (
        let i = 0;
        i < 300 &&
        ["queued", "running", "yielded"].includes(
          app.store.memory.get("jobs", job.id)!.status,
        );
        i++
      )
        await new Promise((r) => setTimeout(r, 10));
      expect(app.store.memory.get("jobs", job.id)?.status).toBe("completed");
      const extraction = fixture.requests.filter((r) =>
        r.messages[0]?.content.includes("MyAgent 长期记忆第"),
      );
      expect(extraction).toHaveLength(2);
      expect(
        extraction.every(
          (r) => !r.tools || (r.tools as unknown[]).length === 0,
        ),
      ).toBe(true);
      if (protocol === "responses")
        expect(
          extraction.every(
            (r) => r.store === false && r.previous_response_id === undefined,
          ),
        ).toBe(true);
      await run(second.id, "忘掉偏好，只删除验收偏好这条。");
      expect(
        (await app.memories.search({ query: "验收偏好" })).entries,
      ).toHaveLength(0);
      const response = await app.server.inject({
        method: "GET",
        url: "/api/v1/memories",
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("credentialRef");
      expect(response.body).not.toContain("sk-memory-fixture-secret");
    } finally {
      await app.server.close();
      await fixture.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
