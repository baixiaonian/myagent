/**
 * 完全访问产品链路：模型为确定性替身，HTTP、持久 Run、工具、真实进程和网络均实际执行。
 * 只操作本例临时目录与 loopback 测试服务器，不使用用户配置、真实密钥或付费模型。
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import { SqliteChatStore } from "../../packages/adapters/src/index.js";
import type {
  ExecutionMode,
  RunAccepted,
  ToolCall,
} from "../../packages/contracts/src/index.js";
import type { ModelPort } from "../../packages/kernel/src/index.js";

let root: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let commands: ToolCall[];
let selectMcp = false;
let received = 0;
let api: ReturnType<typeof createServer>;
let url: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "myagent-full-access-")));
  await mkdir(join(root, "work"));
  received = 0;
  api = createServer((_request, response) => {
    received++;
    response.end("NETWORK_OK");
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string")
    throw new Error("fixture address");
  url = `http://127.0.0.1:${address.port}`;
  const model: ModelPort = {
    async *stream(messages, _signal, definitions) {
      if (selectMcp && !messages.some((m) => m.role === "tool")) {
        const tool = definitions?.find((d) => d.name.startsWith("mcp_"));
        if (!tool) throw new Error("完全访问 MCP 未进入实际模型请求");
        commands = [call(tool.name, { text: "FULL_MCP_OK" })];
      }
      const calls = messages.some((message) => message.role === "tool")
        ? []
        : commands;
      const content = calls.length ? "执行测试动作" : "已完成测试";
      yield { type: "text", text: content };
      yield {
        type: "done",
        finishReason: calls.length ? "tool_calls" : "stop",
        usage: null,
        response: { content, toolCalls: calls },
      };
    },
  };
  app = await buildServer({
    dataDir: join(root, "data"),
    serveWeb: false,
    modelFactory: () => model,
  });
  app.settings.save({
    apiProtocol: "responses",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    systemPrompt: "",
    apiKey: "fixture",
    expectedRevision: 0,
  });
  commands = [];
  selectMcp = false;
});
afterEach(async () => {
  await app?.server.close();
  await new Promise<void>((resolve) => api?.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});
const call = (name: string, args: unknown): ToolCall => ({
  id: randomUUID(),
  name,
  arguments: JSON.stringify(args),
});
async function send(mode?: ExecutionMode) {
  const session = await app.projects.create({
    requestId: randomUUID(),
    path: join(root, "work"),
  });
  const input = {
    requestId: randomUUID(),
    expectedRevision: session.revision,
    content: "执行权限验收",
    ...(mode ? { executionMode: mode } : {}),
  };
  const response = await app.server.inject({
    method: "POST",
    url: `/api/v1/sessions/${session.id}/runs`,
    payload: input,
  });
  expect(response.statusCode).toBe(202);
  return { ...(response.json() as RunAccepted), input };
}
async function settled(runId: string) {
  await expect
    .poll(
      () =>
        ["running", "cleaning", "waiting_agents"].includes(
          app.store.getRun(runId).status,
        ),
      { timeout: 15000 },
    )
    .toBe(false);
  return app.store.getRun(runId);
}

it("完全访问执行真实 Shell、项目外文件和本机网络，不产生审批；Run 及幂等模式持久保存", async () => {
  const outside = join(root, "outside.txt");
  const removed = join(root, "remove-me.txt");
  await writeFile(removed, "only this temporary fixture");
  commands = [
    call("write_file", {
      path: outside,
      content: "OUTSIDE_OK",
      expectedHash: null,
    }),
    call("exec_command", {
      command: `cat '${outside}'; rm '${removed}'; node -e 'fetch("${url}").then(r=>r.text()).then(console.log)'`,
      yieldTimeMs: 1000,
    }),
  ];
  const accepted = await send("full_access");
  expect((await settled(accepted.run.id)).status).toBe("succeeded");
  expect(await readFile(outside, "utf8")).toBe("OUTSIDE_OK");
  await expect(readFile(removed)).rejects.toMatchObject({ code: "ENOENT" });
  expect(received).toBe(1);
  const records = app.store.execution.list("invocations", {
    runId: accepted.run.id,
  });
  expect(records).toHaveLength(2);
  expect(
    records.every(
      (item) =>
        item.status === "succeeded" && item.executionMode === "full_access",
    ),
  ).toBe(true);
  expect(JSON.stringify(records)).toContain("NETWORK_OK");
  expect(
    app.store.execution.list("approvals", { runId: accepted.run.id }),
  ).toEqual([]);
  expect(app.store.execution.list("grants")).toEqual([]);
  const replay = app.chat.start(accepted.run.sessionId, accepted.input);
  expect(replay.run.id).toBe(accepted.run.id);
  expect(() =>
    app.chat.start(accepted.run.sessionId, {
      ...accepted.input,
      executionMode: "standard",
    }),
  ).toThrow(/请求标识/);
  await app.server.close();
  const reopened = new SqliteChatStore(join(root, "data", "state.db"));
  try {
    expect(reopened.getRun(accepted.run.id).executionMode).toBe("full_access");
  } finally {
    reopened.close();
  }
}, 30000);

it("省略模式保持标准权限，解释器请求停在审批且不创建进程；非法模式被 HTTP 拒绝", async () => {
  commands = [call("exec_command", { command: `node -e 'fetch("${url}")'` })];
  const accepted = await send();
  expect((await settled(accepted.run.id)).status).toBe("waiting_approval");
  expect(app.store.getRun(accepted.run.id).executionMode).toBe("standard");
  expect(received).toBe(0);
  expect(
    app.store.execution.list("processes", { runId: accepted.run.id }),
  ).toEqual([]);
  const invalid = await app.server.inject({
    method: "POST",
    url: `/api/v1/sessions/${accepted.run.sessionId}/runs`,
    payload: {
      ...accepted.input,
      requestId: randomUUID(),
      executionMode: "root",
    },
  });
  expect(invalid.statusCode).toBe(400);
});

it("完全访问仍校验工具参数与文件版本，不把无效操作伪装成成功", async () => {
  const target = join(root, "outside.txt");
  await writeFile(target, "original");
  commands = [
    call("write_file", {
      path: target,
      content: "overwrite",
      expectedHash: "stale",
    }),
    call("exec_command", {
      command: "echo forged",
      executionMode: "full_access",
    }),
  ];
  const accepted = await send("full_access");
  await settled(accepted.run.id);
  expect(await readFile(target, "utf8")).toBe("original");
  expect(
    app.store.execution
      .list("invocations", { runId: accepted.run.id })
      .every((item) => item.result?.ok === false),
  ).toBe(true);
  expect(
    app.store.execution.list("approvals", { runId: accepted.run.id }),
  ).toEqual([]);
});

it("完全访问的停止仍终止真实进程，不仅停止等待结果", async () => {
  commands = [call("exec_command", { command: "sleep 60", yieldTimeMs: 1000 })];
  const accepted = await send("full_access");
  await expect
    .poll(
      () =>
        app.gateway
          .processes(accepted.run.id)
          .some((p) => p.status === "running"),
      { timeout: 5000 },
    )
    .toBe(true);
  await app.chat.cancel(accepted.run.id);
  expect((await settled(accepted.run.id)).status).toBe("cancelled");
  expect(
    app.gateway
      .processes(accepted.run.id)
      .some((p) => p.status === "running" || p.status === "unknown"),
  ).toBe(false);
  expect(
    app.store.execution.list("approvals", { runId: accepted.run.id }),
  ).toEqual([]);
}, 15000);

// stdio 注册并不预先建立 full 连接；真实 Run 准备必须将正确模式的定义送入模型。
it("完整 Run 自动连接完全访问 MCP，执行回执返回模型且没有 MCP 审批", async () => {
  const workspace = await app.toolSystem.createWorkspace(
    join(root, "work"),
    "MCP 执行项目",
  );
  const connection = await app.mcpSettings.save({
    name: "full-run-mcp",
    transport: "stdio",
    command: process.execPath,
    args: [join(process.cwd(), "tests/execution/mcp-server.mjs")],
    auth: "none",
    workspaceIds: [workspace.id],
    toolExposure: "direct",
  });
  selectMcp = true;
  const accepted = await send("full_access");
  expect((await settled(accepted.run.id)).status).toBe("succeeded");
  const records = app.store.execution.list("invocations", {
    runId: accepted.run.id,
  });
  expect(records).toHaveLength(1);
  expect(records[0]?.status).toBe("succeeded");
  expect(JSON.stringify(records[0]?.result)).toContain("FULL_MCP_OK");
  expect(
    app.store.execution.list("approvals", { runId: accepted.run.id }),
  ).toEqual([]);
  expect(app.mcp.state(connection.id, workspace.id, "full_access").status).toBe(
    "connected",
  );
}, 20000);
