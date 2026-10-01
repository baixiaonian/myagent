/** Skill 原生隔离验收：真实 shell 和 OS 沙箱，只在临时目录批准本次调用，检查只读包与数据隔离。 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import type { ModelPort } from "../../packages/kernel/src/index.js";

for (const restart of [false, true])
  it.runIf(process.env.MYAGENT_TEST_NATIVE === "1")(
    `技能脚本审批与沙箱隔离（重启恢复=${restart}）`,
    async () => {
      const root = realpathSync(
          mkdtempSync(join(tmpdir(), "myagent-skill-native-")),
        ),
        source = join(root, "skills"),
        skill = join(source, "report"),
        data = join(root, "data");
      mkdirSync(join(skill, "scripts"), { recursive: true });
      mkdirSync(data);
      writeFileSync(join(data, "private-canary"), "PRIVATE_SKILL_CANARY_219");
      writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: report\ndescription: 验证报告脚本\n---\n使用 scripts/check.sh 验证报告。",
      );
      writeFileSync(
        join(skill, "scripts/check.sh"),
        `#!/bin/sh\nprintf verified > result.txt\nif cat '${join(data, "private-canary")}'; then echo LEAKED; else echo SECRET_BLOCKED; fi\nif printf changed > "$0"; then echo MUTATED; else echo READ_ONLY; fi\n`,
      );
      let app: Awaited<ReturnType<typeof buildServer>> | undefined;
      const model: ModelPort = {
        async *stream(messages) {
          const results = messages.filter((m) => m.role === "tool");
          const path = messages
            .find((m) => m.content.includes("本轮技能说明"))
            ?.content.match(/运行根目录 ([^。]+)。/)?.[1];
          if (!path) throw new Error("no skill");
          yield {
            type: "done",
            finishReason: results.length ? "stop" : "tool_calls",
            usage: null,
            response: {
              content: results.length ? "验证完成" : "运行验证脚本",
              toolCalls: results.length
                ? []
                : [
                    {
                      id: "exec",
                      name: "exec_command",
                      arguments: JSON.stringify({
                        command: `/bin/sh '${path}/scripts/check.sh'`,
                        yieldTimeMs: 1000,
                      }),
                    },
                  ],
            },
          };
        },
      };
      try {
        app = await buildServer({
          dataDir: data,
          skillRoot: source,
          workspaceRoot: join(root, "work"),
          serveWeb: false,
          modelFactory: () => model,
        });
        app.settings.save({
          baseUrl: "http://127.0.0.1:1/v1",
          model: "fake",
          apiProtocol: "responses",
          apiKey: "fake",
          systemPrompt: "",
          expectedRevision: 0,
        });
        const session = await app.projects.create({
            requestId: crypto.randomUUID(),
          }),
          workspace = app.toolSystem.workspace(session.id)!;
        const entry = app.skills.catalog().entries[0]!;
        const accepted = app.chat.start(session.id, {
          requestId: crypto.randomUUID(),
          expectedRevision: session.revision,
          content: "验证报告",
          skillIds: [entry.id],
        });
        await expect
          .poll(() => app!.store.getRun(accepted.run.id).status, {
            timeout: 10000,
          })
          .toBe("waiting_approval");
        expect(existsSync(join(workspace.path, "result.txt"))).toBe(false);
        const approval = app.store.execution.list("approvals", {
          runId: accepted.run.id,
        })[0]!;
        expect(approval.command?.decision).toBe("prompt");
        if (restart) {
          const active = app.store.skills.get("runs", accepted.run.id)!
            .active[0]!;
          await app.server.close();
          chmodSync(active.runtimePath, 0o700);
          rmSync(active.runtimePath, { recursive: true, force: true });
          writeFileSync(
            join(skill, "scripts/check.sh"),
            "echo WRONG_VERSION > result.txt",
          );
          app = await buildServer({
            dataDir: data,
            skillRoot: source,
            workspaceRoot: join(root, "work"),
            serveWeb: false,
            modelFactory: () => model,
          });
          expect(app.store.getRun(accepted.run.id).status).toBe("recoverable");
        }
        const response = await app.server.inject({
          method: "POST",
          url: `/api/v1/approvals/${approval.id}/decision`,
          payload: {
            requestId: crypto.randomUUID(),
            decision: "allow",
            scope: "once",
          },
        });
        expect(response.statusCode).toBe(200);
        await expect
          .poll(() => app!.store.getRun(accepted.run.id).status, {
            timeout: 15000,
          })
          .toBe("succeeded");
        expect(readFileSync(join(workspace.path, "result.txt"), "utf8")).toBe(
          "verified",
        );
        const result = JSON.stringify(
          app.store.execution.list("invocations", { runId: accepted.run.id }),
        );
        expect(result).toContain("SECRET_BLOCKED");
        expect(result).toContain("READ_ONLY");
        expect(result).not.toContain("PRIVATE_SKILL_CANARY_219");
        expect(
          app.store.execution.list("approvals", { runId: accepted.run.id }),
        ).toHaveLength(1);
      } finally {
        if (app) {
          await app.server.close();
          app.skills.files.collect(new Set());
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );
