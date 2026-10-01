/** 命令权限 API 与重启验证：使用真实应用和持久层，模型/派发计数替身不代表 OS 验收。 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import type { ModelPort } from "../../packages/kernel/src/index.js";

let root: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let dispatched = 0;
let requests = 0;
const model: ModelPort = {
  async *stream(messages) {
    requests++;
    const finished = messages.some((message) => message.role === "tool");
    yield {
      type: "done",
      finishReason: finished ? "stop" : "tool_calls",
      usage: null,
      response: {
        content: finished ? "已收到命令执行反馈。" : "",
        toolCalls: finished
          ? []
          : [
              {
                id: "command",
                name: "exec_command",
                arguments: '{"command":"rm file"}',
              },
            ],
      },
    };
  },
};
async function open() {
  app = await buildServer({
    dataDir: join(root, "data"),
    workspaceRoot: join(root, "defaults"),
    serveWeb: false,
    modelFactory: () => model,
  });
  app.gateway.dispatch = async (request) => {
    await request.onAccepted?.(null);
    dispatched++;
    return {
      attemptId: request.attemptId,
      invocationId: request.context.invocationId,
      outcome: "succeeded",
      data: { output: "fixture" },
      error: null,
      effectsPossible: true,
      completedAt: new Date().toISOString(),
    };
  };
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "myagent-command-api-")));
  dispatched = 0;
  requests = 0;
  await open();
});
afterEach(async () => {
  await app?.server.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function until(runId: string, status: string) {
  await expect.poll(() => app.store.getRun(runId).status).toBe(status);
}
it("设置保存/并发/项目确认/无执行测试通过公共 HTTP，外部改动使精确确认失效", async () => {
  const session = (
    await app.server.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: {},
    })
  ).json();
  const workspace = app.store.execution.get("workspaces", session.workspaceId);
  if (!workspace) throw new Error("workspace");
  const url = `/api/v1/command-policy/config?scope=project&workspaceId=${workspace.id}`;
  const config = (await app.server.inject(url)).json();
  await mkdir(join(workspace.path, ".myagent"));
  await writeFile(
    config.path,
    '{"schemaVersion":1,"rules":[{"id":"rm","pattern":["rm"],"decision":"allow"}]}',
  );
  const pending = (await app.server.inject(url)).json();
  expect(pending.pending).toBe(true);
  const stale = await app.server.inject({
    method: "POST",
    url: "/api/v1/command-policy/config/confirm",
    payload: {
      scope: "project",
      workspaceId: workspace.id,
      expectedRevision: config.revision,
    },
  });
  expect(stale.statusCode).toBe(409);
  const confirmed = await app.server.inject({
    method: "POST",
    url: "/api/v1/command-policy/config/confirm",
    payload: {
      scope: "project",
      workspaceId: workspace.id,
      expectedRevision: pending.revision,
    },
  });
  expect(confirmed.json().pending).toBe(false);
  const result = await app.server.inject({
    method: "POST",
    url: "/api/v1/command-policy/evaluate",
    payload: { workspaceId: workspace.id, command: "rm file" },
  });
  expect(result.json().decision).toBe("allow");
  expect(dispatched).toBe(0);
  const user = (
    await app.server.inject("/api/v1/command-policy/config?scope=user")
  ).json();
  const saved = await app.server.inject({
    method: "PUT",
    url: "/api/v1/command-policy/config",
    payload: {
      scope: "user",
      expectedRevision: user.revision,
      text: '{"schemaVersion":1,"rules":[{"id":"rm","pattern":["rm"],"decision":"deny"}]}',
    },
  });
  expect(saved.statusCode).toBe(200);
  const denied = await app.server.inject({
    method: "POST",
    url: "/api/v1/command-policy/evaluate",
    payload: { workspaceId: workspace.id, command: "rm file" },
  });
  expect(denied.json().decision).toBe("deny");
  expect(dispatched).toBe(0);
  expect(
    (
      await app.server.inject({
        method: "POST",
        url: "/api/v1/command-policy/evaluate",
        payload: { workspaceId: workspace.id, command: "pwd", surprise: true },
      })
    ).statusCode,
  ).toBe(400);
});
it("审批刷新/重启不重放模型或命令，旧资源批准不能代替新命令批准", async () => {
  app.settings.save({
    apiProtocol: "responses",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    apiKey: "fake",
    systemPrompt: "",
    expectedRevision: 0,
  });
  const session = (
    await app.server.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: {},
    })
  ).json();
  const run = app.chat.start(session.id, {
    requestId: randomUUID(),
    expectedRevision: session.revision,
    content: "删除测试文件",
  }).run;
  await until(run.id, "waiting_approval");
  expect(requests).toBe(1);
  expect(dispatched).toBe(0);
  const first = app.store.execution.list("approvals", { runId: run.id })[0];
  if (!first) throw new Error("approval");
  // 模拟升级前已批准的资源记录：删除命令证据，保留原合法批准，恢复后必须重新询问。
  const { command: _command, ...legacy } = first;
  app.store.execution.put("approvals", legacy);
  app.toolSystem.decide(first.id, {
    requestId: "old",
    decision: "allow",
    scope: "workspace",
  });
  await app.server.close();
  await open();
  expect(requests).toBe(1);
  expect(dispatched).toBe(0);
  await app.chat.resume(run.id);
  await until(run.id, "waiting_approval");
  expect(requests).toBe(1);
  const pending = app.store.execution
    .list("approvals", { runId: run.id })
    .find((a) => a.status === "pending");
  if (!pending) throw new Error("pending");
  expect(pending.command).toBeTruthy();
  const invalid = await app.server.inject({
    method: "POST",
    url: `/api/v1/approvals/${pending.id}/decision`,
    payload: { requestId: "bad", decision: "allow", scope: "session" },
  });
  expect(invalid.statusCode).toBe(400);
  const accepted = await app.server.inject({
    method: "POST",
    url: `/api/v1/approvals/${pending.id}/decision`,
    payload: { requestId: "once", decision: "allow", scope: "once" },
  });
  expect(accepted.statusCode).toBe(200);
  await until(run.id, "succeeded");
  expect(requests).toBe(2);
  expect(dispatched).toBe(1);
  await app.server.close();
  await open();
  expect(dispatched).toBe(1);
  expect(requests).toBe(2);
});
