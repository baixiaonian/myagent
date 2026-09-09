/**
 * 真实模型验收脚本：经本机产品 API 验证多轮、幂等、重新生成和流式停止。
 * 执行会产生模型调用费用，需本轮明确授权；不读凭证文件、不改用户配置或已有会话。
 * 只记录本脚本创建的会话和脱敏验收结果到 .cache/acceptance。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

// 仅在用户明确授权真实模型验收后运行；会产生模型调用费用。
// 使用已保存的配置，不读取凭证文件、不覆盖配置、不访问用户其他会话。
const base = process.env.MYAGENT_TEST_URL ?? "http://127.0.0.1:3001";
const url = new URL(base);
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
  "验收只能访问本机产品",
);
const results = {
  date: new Date().toISOString(),
  model: "",
  sessionId: "",
  checks: [],
  runs: [],
};
async function api(path, method = "GET", data) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(140000),
  });
  if (!response.ok) {
    const value = await response.json();
    throw new Error(`${response.status}: ${value.error?.code ?? "http_error"}`);
  }
  return response.status === 204 ? null : response.json();
}
function passed(name) {
  results.checks.push(name);
  console.info(`PASS ${name}`);
}
// 从接受快照的游标开始观测 SSE，累计增量后与最终已保存答案比较，验证传输和持久化一致。
async function observe(accepted, cancelOnText = false) {
  const { run, snapshot } = accepted;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 140000);
  let parts = 0;
  let length = 0;
  let cancelRequested = false;
  let terminal = null;
  try {
    const response = await fetch(
      `${base}/api/v1/sessions/${run.sessionId}/events?after=${snapshot.cursor}`,
      { signal: abort.signal },
    );
    assert(response.ok, "SSE 建立失败");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!terminal) {
      const chunk = await reader.read();
      if (chunk.done) break;
      // 网络分片可能切开 UTF-8 字符或事件帧；流式解码后按空行拼出完整 SSE 数据。
      buffer += decoder.decode(chunk.value, { stream: true });
      while (buffer.includes("\n\n")) {
        const end = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const json = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (!json) continue;
        const event = JSON.parse(json);
        if (
          event.type === "message.delta" &&
          event.messageId === run.assistantMessageId
        ) {
          parts++;
          length += event.delta.length;
          // 收到真实文字后再发停止，确保验收的是“保留部分回答”，而不是请求尚未开始就取消。
          if (cancelOnText && !cancelRequested) {
            cancelRequested = true;
            await api(`/runs/${run.id}/cancel`, "POST", {});
          }
        }
        if (
          event.type === "run.updated" &&
          event.run.id === run.id &&
          event.run.status !== "running"
        )
          terminal = event.run;
      }
    }
    assert(terminal, "缺少运行终态");
    const latest = await api(`/sessions/${run.sessionId}`);
    const answer = latest.messages.find(
      (message) => message.id === run.assistantMessageId,
    );
    assert(answer, "缺少持久化回答");
    assert(parts > 0 && length > 0, "没有观测到真实文字增量");
    assert.equal(
      terminal.status,
      cancelOnText ? "cancelled" : "succeeded",
      `运行失败：${terminal.error?.code}`,
    );
    assert.equal(answer.content.length, length, "事件文字和已保存回答不一致");
    results.runs.push({
      id: run.id,
      status: terminal.status,
      deltaEvents: parts,
      characters: answer.content.length,
      finishReason: terminal.finishReason,
      elapsedMs: Date.parse(terminal.endedAt) - Date.parse(terminal.createdAt),
    });
    return { run: terminal, snapshot: latest, answer };
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}
try {
  const settings = await api("/settings");
  assert(settings.configured && settings.hasKey, "尚未配置有效连接");
  assert(
    !("apiKey" in settings) && !("credentialRef" in settings),
    "设置响应存在凭证字段",
  );
  results.model = settings.model;
  const session = await api("/sessions", "POST", {});
  results.sessionId = session.id;
  await api(`/sessions/${session.id}`, "PATCH", {
    title: "真实模型验收 · 多轮与停止",
    expectedRevision: 0,
  });
  const beforeTest = await api(`/sessions/${session.id}`);
  await api("/settings/test", "POST", {
    baseUrl: settings.baseUrl,
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    expectedRevision: settings.revision,
  });
  assert.deepEqual(await api(`/sessions/${session.id}`), beforeTest);
  passed("已保存连接的实际模型测试，不写聊天历史");
  // 每次产生新的随机暗号，第二轮不重复给出答案，避免固定回复被误判为多轮上下文有效。
  const marker = `松果-${crypto.randomUUID().slice(0, 8)}`;
  const firstInput = {
    requestId: crypto.randomUUID(),
    expectedRevision: beforeTest.session.revision,
    content: `这是聊天软件验收。临时暗号是 ${marker}。请记住，且只回复“已记住”。`,
  };
  const firstAccepted = await api(
    `/sessions/${session.id}/runs`,
    "POST",
    firstInput,
  );
  const repeated = await api(
    `/sessions/${session.id}/runs`,
    "POST",
    firstInput,
  );
  assert.equal(repeated.run.id, firstAccepted.run.id);
  const first = await observe(firstAccepted);
  passed("首轮真实文字流、落盘及重复提交幂等");
  const secondAccepted = await api(`/sessions/${session.id}/runs`, "POST", {
    requestId: crypto.randomUUID(),
    expectedRevision: first.snapshot.session.revision,
    content: "我上一轮告诉你的临时暗号是什么？请只输出暗号，不要解释。",
  });
  const second = await observe(secondAccepted);
  assert(second.answer.content.includes(marker), "第二轮未正确回忆第一轮暗号");
  passed("第二轮准确引用第一轮随机暗号");
  const regenerated = await observe(
    await api(`/sessions/${session.id}/regenerate`, "POST", {
      requestId: crypto.randomUUID(),
      expectedRevision: second.snapshot.session.revision,
    }),
  );
  assert(
    regenerated.answer.content.includes(marker),
    "重新生成的答案未回忆暗号",
  );
  assert.equal(
    regenerated.snapshot.messages.find(
      (message) => message.id === second.answer.id,
    ).status,
    "superseded",
  );
  assert.equal(
    regenerated.snapshot.messages.filter((message) => message.role === "user")
      .length,
    2,
  );
  passed("真实重新生成成功替换原答，不重复问题");
  const stopped = await observe(
    await api(`/sessions/${session.id}/runs`, "POST", {
      requestId: crypto.randomUUID(),
      expectedRevision: regenerated.snapshot.session.revision,
      content:
        "请逐条列出 1 到 200，每条附一段约 30 字的自然景色描述，每条独立一行，直接开始，不要前言，不要省略。",
    }),
    true,
  );
  assert(stopped.answer.content.length > 0);
  await delay(500);
  const restored = await api(`/sessions/${session.id}`);
  assert.equal(restored.activeRun, null);
  assert.equal(
    restored.messages.find((message) => message.id === stopped.answer.id)
      .content,
    stopped.answer.content,
  );
  passed("真实流停止后保留部分回答，重新读取恢复且不再追加");
  const afterSettings = await api("/settings");
  assert.equal(afterSettings.revision, settings.revision);
  passed("测试未修改用户活动配置或密钥");
  results.ok = true;
} catch (error) {
  results.ok = false;
  results.failure = error instanceof Error ? error.message : "验收失败";
  console.error(results.failure);
  process.exitCode = 1;
} finally {
  // 成功与失败均保存有限验收证据；不写原始密钥或整段用户历史，报告权限限定为当前用户。
  mkdirSync(".cache/acceptance", { recursive: true });
  writeFileSync(
    ".cache/acceptance/live-model.json",
    `${JSON.stringify(results, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.info(JSON.stringify(results));
}
