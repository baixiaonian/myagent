/** Hook 原生验收：真实单次脚本、权限不同的 Worker、进程终止及日志保存；只操作自建临时目录。 */
import {
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
import { LocalHookFiles } from "../../packages/adapters/src/index.js";
import type { HookEvent } from "../../packages/contracts/src/index.js";

const model = {
  async *stream() {
    yield {
      type: "done" as const,
      finishReason: "stop",
      usage: null,
      response: { content: "完成", toolCalls: [] },
    };
  },
};
it.runIf(process.env.MYAGENT_TEST_NATIVE === "1")(
  "真实 Hook 默认只读、明确授权写入、私有凭证/包只读及超时终止",
  async () => {
    const root = realpathSync(
        mkdtempSync(join(tmpdir(), "myagent-hooks-native-")),
      ),
      data = join(root, "data"),
      pkg = join(root, "package");
    mkdirSync(data);
    mkdirSync(pkg);
    const canary = join(data, "canary");
    writeFileSync(canary, "HOOK_PRIVATE_CANARY");
    writeFileSync(
      join(pkg, "main.mjs"),
      `/** 原生隔离验收脚本。 */\nimport fs from 'node:fs';const e=JSON.parse(fs.readFileSync(0,'utf8'));let flags=[];try{fs.readFileSync(${JSON.stringify(canary)});flags.push('SECRET_LEAK')}catch{flags.push('SECRET_BLOCKED')}try{fs.writeFileSync(new URL('./main.mjs',import.meta.url),'x');flags.push('PACKAGE_MUTATED')}catch{flags.push('PACKAGE_READONLY')}try{fs.writeFileSync('result.txt','authorized');flags.push('WRITE_OK')}catch{flags.push('WRITE_BLOCKED')}console.error('独立stderr日志');console.log(JSON.stringify({decision:'continue',...(e.event==='RunEnd'?{}:{additionalContext:flags.join(',')})}));`,
    );
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    try {
      app = await buildServer({
        dataDir: data,
        workspaceRoot: join(root, "work"),
        skillRoot: join(root, "skills"),
        serveWeb: false,
        modelFactory: () => model,
      });
      app.settings.save({
        baseUrl: "http://127.0.0.1:1/v1",
        model: "fixture",
        apiProtocol: "responses",
        apiKey: "fixture",
        systemPrompt: "",
        expectedRevision: 0,
      });
      const session = await app.projects.create({
          requestId: crypto.randomUUID(),
        }),
        workspace = app.toolSystem.workspace(session.id)!;
      async function configure(
        writePaths: string[],
        timeoutMs = 10000,
        event: HookEvent = "RunStart",
      ) {
        const before = app!.hooks.view({ scope: "user" }),
          text = JSON.stringify({
            schemaVersion: 1,
            hooks: [
              {
                id: "check",
                event,
                enabled: true,
                packagePath: pkg,
                entry: "main.mjs",
                interpreter: "node",
                args: [],
                timeoutMs,
                permissions: { writePaths, networkDomains: [] },
              },
            ],
          });
        const preview = await app!.hooks.save({
          scope: "user",
          text,
          expectedRevision: before.revision,
        });
        expect(preview.error).toBeNull();
        await app!.hooks.save({
          scope: "user",
          text,
          expectedRevision: before.revision,
          expectedVersion: preview.version,
        });
      }
      async function run() {
        const s = app!.store.snapshot(session.id).session,
          r = app!.chat.start(s.id, {
            requestId: crypto.randomUUID(),
            expectedRevision: s.revision,
            content: "检查目录",
          }).run;
        await expect
          .poll(() => app!.store.getRun(r.id).status, { timeout: 20000 })
          .not.toMatch(/^(queued|running|cleaning)$/);
        return app!.store.getRun(r.id);
      }
      await configure([]);
      const first = await run();
      expect(first.status).toBe("succeeded");
      const firstRecord = app.hooks
        .records(session.id)
        .find((h) => h.runId === first.id)!;
      expect(firstRecord.output?.additionalContext).toContain("WRITE_BLOCKED");
      expect(firstRecord.output?.additionalContext).toContain("SECRET_BLOCKED");
      expect(firstRecord.output?.additionalContext).toContain(
        "PACKAGE_READONLY",
      );
      expect(existsSync(join(workspace.path, "result.txt"))).toBe(false);
      expect(firstRecord.logRef).toBeTruthy();
      expect(
        (
          await app.toolSystem.options.results.read(
            firstRecord.logRef!,
            session.id,
          )
        ).text,
      ).toContain("独立stderr日志");
      await configure(["result.txt"]);
      expect((await run()).status).toBe("succeeded");
      expect(readFileSync(join(workspace.path, "result.txt"), "utf8")).toBe(
        "authorized",
      );
      writeFileSync(join(pkg, "main.mjs"), "setInterval(()=>{},1000);\n");
      await configure([], 300);
      const last = await run();
      expect(last.status).toBe("failed");
      expect(
        app.store.execution
          .list("processes", { runId: last.id })
          .some((p) => p.status === "running"),
      ).toBe(false);
    } finally {
      if (app) {
        await app.server.close();
        new LocalHookFiles(data, app.store.execution).packages.collect(
          new Set(),
        );
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
it.runIf(process.env.MYAGENT_TEST_NATIVE === "1")(
  "审批暂停重启恢复旧 Hook 包，RunStart 和前置检查不重放",
  async () => {
    const root = realpathSync(
        mkdtempSync(join(tmpdir(), "myagent-hook-restart-")),
      ),
      data = join(root, "data"),
      pkg = join(root, "package");
    mkdirSync(pkg);
    writeFileSync(
      join(pkg, "main.mjs"),
      "import fs from 'node:fs'; const e=JSON.parse(fs.readFileSync(0,'utf8')); fs.appendFileSync('audit.txt',e.event+'\\n'); console.log(JSON.stringify({decision:'continue'}));",
    );
    const model = {
      async *stream(
        messages: readonly import("../../packages/kernel/src/index.js").ModelMessage[],
      ) {
        yield {
          type: "done" as const,
          finishReason: messages.some((m) => m.role === "tool")
            ? "stop"
            : "tool_calls",
          usage: null,
          response: {
            content: "验证",
            toolCalls: messages.some((m) => m.role === "tool")
              ? []
              : [
                  {
                    id: "exec",
                    name: "exec_command",
                    arguments: JSON.stringify({
                      command: "printf done > result.txt",
                      yieldTimeMs: 1000,
                    }),
                  },
                ],
          },
        };
      },
    };
    const options = {
      dataDir: data,
      workspaceRoot: join(root, "work"),
      skillRoot: join(root, "skills"),
      serveWeb: false,
      modelFactory: () => model,
    };
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    try {
      app = await buildServer(options);
      app.settings.save({
        baseUrl: "http://127.0.0.1:1/v1",
        model: "fixture",
        apiProtocol: "responses",
        apiKey: "fixture",
        systemPrompt: "",
        expectedRevision: 0,
      });
      const before = app.hooks.view({ scope: "user" }),
        text = JSON.stringify({
          schemaVersion: 1,
          hooks: ["RunStart", "PreToolUse", "PostToolUse", "RunEnd"].map(
            (event) => ({
              id: event,
              event,
              enabled: true,
              packagePath: pkg,
              entry: "main.mjs",
              interpreter: "node",
              args: [],
              timeoutMs: 10000,
              permissions: { writePaths: ["audit.txt"], networkDomains: [] },
            }),
          ),
        });
      const preview = await app.hooks.save({
        scope: "user",
        text,
        expectedRevision: before.revision,
      });
      await app.hooks.save({
        scope: "user",
        text,
        expectedRevision: before.revision,
        expectedVersion: preview.version,
      });
      const session = await app.projects.create({
          requestId: crypto.randomUUID(),
        }),
        workspace = app.toolSystem.workspace(session.id)!,
        r = app.chat.start(session.id, {
          requestId: crypto.randomUUID(),
          expectedRevision: session.revision,
          content: "验证命令",
        }).run;
      await expect
        .poll(() => app!.store.getRun(r.id).status, { timeout: 15000 })
        .toBe("waiting_approval");
      const approval = app.store.execution.list("approvals", {
          runId: r.id,
        })[0]!,
        frozen = app.store.hooks.get("runs", r.id)!.hooks[0]!;
      await app.server.close();
      app = undefined;
      // 丢失临时副本并改写源包，恢复仍从持久快照生成相同内容。
      const { chmodSync } = await import("node:fs");
      chmodSync(frozen.package.runtimePath, 0o700);
      rmSync(frozen.package.runtimePath, { recursive: true, force: true });
      writeFileSync(join(pkg, "main.mjs"), "throw new Error('WRONG_VERSION')");
      app = await buildServer(options);
      expect(app.hooks.view({ scope: "user" }).blocking).toBe(true);
      expect(readFileSync(join(workspace.path, "audit.txt"), "utf8")).toBe(
        "RunStart\nPreToolUse\n",
      );
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
        .poll(() => app!.store.getRun(r.id).status, { timeout: 20000 })
        .toBe("succeeded");
      expect(readFileSync(join(workspace.path, "result.txt"), "utf8")).toBe(
        "done",
      );
      expect(readFileSync(join(workspace.path, "audit.txt"), "utf8")).toBe(
        "RunStart\nPreToolUse\nPostToolUse\nRunEnd\n",
      );
    } finally {
      if (app) {
        const files = new LocalHookFiles(data, app.store.execution);
        await app.server.close();
        files.packages.collect(new Set());
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
