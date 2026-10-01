/** 长期记忆集成验收：真实临时 Markdown/SQLite 与可控模型，覆盖发布、引用、撤销、预算和恢复，不使用用户数据。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import { LocalMemoryFiles } from "../../packages/adapters/src/memory/files.js";
import { MemoryService } from "../../packages/application/src/memory.js";
import { memoryOverviewEntries } from "../../packages/content/src/index.js";
import type {
  MemoryEntry,
  MemoryJobView,
} from "../../packages/contracts/src/index.js";
import type { ModelPort } from "../../packages/kernel/src/index.js";

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "myagent-memory-test-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await app?.server.close();
  app = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const model: ModelPort = {
  async *stream(messages, _signal, tools) {
    const prompt = messages[0]!.content;
    const data = JSON.parse(messages[1]!.content);
    let text = "";
    if (prompt.includes("第一阶段"))
      text = JSON.stringify({
        memories: [
          {
            title: "日志归档约定",
            text: "本项目将日志归档到 nebula-42 目录。",
            kind: "project",
            projectSpecific: true,
            sourceIndexes: [0],
          },
        ],
      });
    else if (prompt.includes("第二阶段"))
      text = JSON.stringify({
        actions: data.candidates.map(
          (c: { candidateIndex: number; title: string; text: string }) => ({
            ...c,
            action: "add",
          }),
        ),
      });
    else text = "已记录。";
    expect(tools).toEqual([]);
    yield { type: "text", text };
    yield {
      type: "done",
      finishReason: "stop",
      usage,
      response: { content: text, toolCalls: [] },
    };
  },
};
async function setup(
  factory = () => model,
  dataDir = dir(),
  now?: () => number,
) {
  app = await buildServer({
    dataDir,
    serveWeb: false,
    modelFactory: factory,
    ...(now ? { memoryNow: now } : {}),
  });
  app.settings.save({
    baseUrl: "http://127.0.0.1:1/v1",
    apiProtocol: "responses",
    model: "fixture",
    apiKey: "fake-key",
    systemPrompt: "",
    expectedRevision: 0,
  });
  return app;
}
function enable() {
  const s = app!.memories.settings();
  const { revision, enabledAt: _, ...input } = s;
  return app!.memories.saveSettings({
    ...input,
    enabled: true,
    expectedRevision: revision,
  });
}
async function history(content = "日志放在 nebula-42", project?: string) {
  const s = await app!.projects.create({
    requestId: crypto.randomUUID(),
    ...(project ? { path: project } : {}),
  });
  const run = app!.store.beginRun({
    sessionId: s.id,
    expectedRevision: s.revision,
    requestId: crypto.randomUUID(),
    fingerprint: "fixture",
    kind: "send",
    content,
    model: "fixture",
    contextTrimmed: false,
  });
  app!.store.appendDelta(run.id, "已确认约定。");
  app!.store.finishRun(run.id, {
    status: "succeeded",
    finishReason: "stop",
    usage,
    error: null,
  });
  return s;
}
async function waitJob(id: string): Promise<MemoryJobView> {
  for (let i = 0; i < 100; i++) {
    const job = app!.store.memory.get("jobs", id)!;
    if (!["queued", "running", "yielded"].includes(job.status)) return job;
    app!.memories.jobs.kick();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("job timeout");
}
async function add(text = "用户偏好使用中文", title = "表达偏好") {
  return (await app!.memories.update({
    requestId: crypto.randomUUID(),
    action: "add",
    title,
    text,
    kind: "preference",
  }))!;
}
it("默认关闭；新概览有预算且同一 Run 只撤销、不切换普通新版本", async () => {
  await setup();
  const s = await history();
  await add();
  const input = { sessionId: s.id, workspaceId: null, query: "", budget: 2500 };
  expect(await app!.memories.read(input, new AbortController().signal)).toEqual(
    [],
  );
  enable();
  const pieces = await app!.memories.read(input, new AbortController().signal);
  expect(pieces).toHaveLength(1);
  await add("新增另一条偏好", "测试偏好");
  expect(await app!.memories.validate(s.id, pieces)).toEqual(pieces);
  const e = app!.memories.entries()[0]!;
  await app!.memories.update({
    action: "forget",
    id: e.id,
    expectedRevision: e.revision,
    requestId: crypto.randomUUID(),
  });
  expect(await app!.memories.validate(s.id, pieces)).toEqual([]);
  expect(memoryOverviewEntries(app!.memories.entries(), null, 1)).toEqual([]);
});
it("两阶段整理生成文件、跨会话查询原文、来源不能伪造，重复任务不重复调用", async () => {
  await setup();
  enable();
  const s = await history();
  const job = await app!.memories.jobs.create(s.id, "job1");
  expect((await waitJob(job.id)).status).toBe("completed");
  const entry = app!.memories.entries()[0]!;
  expect(entry.sources).toHaveLength(1);
  const artifact = (await app!.memories.readEntry(entry.id)).extractions[0]!;
  expect(
    (await app!.memories.readEntry(entry.id, undefined, artifact.id)).text,
  ).toContain("nebula-42");
  expect(readFileSync(app!.memories.files.paths.memory, "utf8")).toContain(
    "nebula-42",
  );
  expect(readFileSync(app!.memories.files.paths.summary, "utf8")).toContain(
    "日志归档",
  );
  const other = await history("新的任务");
  expect(
    (await app!.memories.search({ query: "日志 nebula" }, other.id)).entries,
  ).toHaveLength(1);
  expect(
    (
      await app!.memories.readEntry(
        entry.id,
        undefined,
        entry.sources[0]!.id,
        other.id,
      )
    ).text,
  ).toContain("nebula-42");
  await expect(
    app!.memories.readEntry(entry.id, undefined, "forged", other.id),
  ).rejects.toMatchObject({ code: "memory_source" });
  expect((await app!.memories.jobs.create(s.id, "job2")).id).toBe(job.id);
  expect(app!.store.memory.get("jobs", job.id)?.requests).toBe(2);
});
it("明确编辑与删除幂等、旧版本拒绝，遗忘后不从旧来源重新提炼", async () => {
  await setup();
  enable();
  const s = await history();
  const job = await app!.memories.jobs.create(s.id, "job");
  await waitJob(job.id);
  const entry = app!.memories.entries()[0]!;
  const input = {
    action: "edit" as const,
    id: entry.id,
    expectedRevision: entry.revision,
    title: entry.title,
    text: "改为 nova-99",
    requestId: "edit",
  };
  const edited = await app!.memories.update(input);
  expect(await app!.memories.update(input)).toEqual(edited);
  await expect(
    app!.memories.update({ ...input, requestId: "edit-again" }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await app!.memories.update({
    action: "forget",
    id: entry.id,
    expectedRevision: edited!.revision,
    requestId: "forget",
  });
  expect(
    app!.memories
      .sourceRecords(s.id)
      .some((r) => r.source.id === entry.sources[0]!.id),
  ).toBe(false);
  expect((await app!.memories.search()).entries).toEqual([]);
});
it("文件外部修改标记人工版本，非法文件不覆盖原文，修复后可继续", async () => {
  await setup();
  const entry = await add();
  const path = app!.memories.files.paths.memory;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("用户偏好使用中文", "用户偏好简洁中文"),
  );
  await app!.memories.refresh();
  expect(app!.memories.entries()[0]).toMatchObject({
    manual: true,
    revision: 2,
    text: "用户偏好简洁中文",
  });
  await expect(
    app!.memories.update({
      action: "edit",
      id: entry.id,
      expectedRevision: 1,
      text: "旧草稿",
      requestId: "stale",
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  const valid = readFileSync(path, "utf8");
  writeFileSync(path, "");
  expect((await app!.memories.overview()).error?.code).toBe("memory_format");
  expect(app!.memories.entries()).toHaveLength(1);
  writeFileSync(path, "broken");
  expect((await app!.memories.overview()).error?.code).toBe("memory_format");
  expect(readFileSync(path, "utf8")).toBe("broken");
  writeFileSync(path, valid);
  expect((await app!.memories.overview()).error).toBeNull();
});
it("正文 rename 后故障保留提交日志，重启修复派生文件和索引且不调用模型", async () => {
  const a = await setup();
  let failure = true;
  const files = new LocalMemoryFiles(
    a.memories.files.paths.memory.replace(/\/memories\/MEMORY.md$/, ""),
    () => {
      if (failure) {
        failure = false;
        throw Error("injected");
      }
    },
  );
  const service = new MemoryService(
    a.store.memory,
    files,
    a.store,
    a.store.execution,
    a.settings,
  );
  service.historyReader = a.memories.historyReader;
  await expect(
    service.update({
      action: "add",
      requestId: "crash",
      title: "恢复",
      text: "保存成功后异常",
      kind: "experience",
    }),
  ).rejects.toThrow("injected");
  expect(a.store.memory.list("commits")).toHaveLength(1);
  await service.initialize();
  expect(a.store.memory.list("commits")).toHaveLength(0);
  expect((await service.search()).entries[0]?.text).toContain("异常");
  expect(a.store.memory.list("jobs")).toHaveLength(0);
});
it("删除会话撤销自动贡献，不删除独立手工记忆；原来源不可继续读取", async () => {
  await setup();
  enable();
  const s = await history();
  const job = await app!.memories.jobs.create(s.id, "job");
  await waitJob(job.id);
  const generated = app!.memories.entries()[0]!;
  await add();
  await app!.chat.deleteSession(s.id);
  expect(app!.memories.entries()).toHaveLength(1);
  expect(app!.memories.entries()[0]?.manual).toBe(true);
  await expect(app!.memories.readEntry(generated.id)).rejects.toMatchObject({
    code: "not_found",
  });
  expect(app!.store.memory.list("jobs")).toHaveLength(0);
});
it("无价值内容不进入第二阶段，模型未提供 usage 显示未知", async () => {
  await setup(() => ({
    async *stream() {
      yield { type: "text", text: '{"memories":[]}' };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  }));
  enable();
  const s = await history();
  const j = await app!.memories.jobs.create(s.id, "empty");
  const end = await waitJob(j.id);
  expect(end.status).toBe("completed");
  expect(end.requests).toBe(1);
  expect(end.usage).toBeNull();
  expect(app!.memories.entries()).toEqual([]);
});
it("每日配额预占，超额暂停；人工调高配额继续已完成分块", async () => {
  await setup();
  const s = enable();
  app!.memories.saveSettings({
    ...s,
    dailyRequests: 1,
    expectedRevision: s.revision,
  });
  const h = await history();
  const j = await app!.memories.jobs.create(h.id, "quota");
  expect((await waitJob(j.id)).status).toBe("waiting_budget");
  expect(app!.store.memory.get("jobs", j.id)?.nextChunk).toBe(1);
  const settings = app!.memories.settings();
  app!.memories.saveSettings({
    ...settings,
    dailyRequests: 10,
    expectedRevision: settings.revision,
  });
  app!.memories.jobs.retry(j.id);
  const end = await waitJob(j.id);
  expect(end.status).toBe("completed");
  expect(end.requests).toBe(2);
});
it("不合作模型的迟到响应不能在取消后发布", async () => {
  let resolve: () => void = () => {};
  const pending = new Promise<void>((r) => {
    resolve = r;
  });
  await setup(() => ({
    async *stream() {
      await pending;
      yield { type: "text", text: '{"memories":[]}' };
      yield { type: "done", finishReason: "stop", usage };
    },
  }));
  enable();
  const s = await history();
  const job = await app!.memories.jobs.create(s.id, "slow");
  app!.memories.jobs.kick();
  for (
    let i = 0;
    i < 50 && !app!.store.memory.get("jobs", job.id)?.requests;
    i++
  )
    await new Promise((r) => setTimeout(r, 5));
  app!.memories.jobs.cancel(job.id);
  resolve();
  await new Promise((r) => setTimeout(r, 30));
  expect(app!.store.memory.get("jobs", job.id)?.status).toBe("cancelled");
  expect(app!.memories.entries()).toEqual([]);
});
it("分页结果受最终 JSON 预算限制，中文查询与来源隔离", async () => {
  await setup();
  enable();
  for (let i = 0; i < 5; i++)
    await add(`中文正文 ${i} ${"长内容".repeat(1200)}`, `标题${i}`);
  const page = await app!.memories.search({ query: "中文 正文", limit: 2 });
  expect(page.entries).toHaveLength(2);
  expect(page.nextCursor).not.toBeNull();
  expect(JSON.stringify(page).length).toBeLessThanOrEqual(8000);
  expect(
    (
      await app!.memories.search({
        query: "中文 正文",
        limit: 2,
        cursor: page.nextCursor!,
      })
    ).entries[0]?.id,
  ).not.toBe(page.entries[0]?.id);
  const read = await app!.memories.readEntry(page.entries[0]!.id);
  expect(JSON.stringify(read).length).toBeLessThanOrEqual(8000);
});
it("人工条目不可由自动合并覆盖，模型错误不暴露内部异常", async () => {
  let id = "";
  await setup(() => ({
    async *stream(messages, signal, tools) {
      if (messages[0]!.content.includes("第二阶段")) {
        yield {
          type: "text",
          text: JSON.stringify({
            actions: [
              {
                candidateIndex: 0,
                action: "replace",
                targetId: id,
                title: "覆盖",
                text: "错误",
              },
            ],
          }),
        };
        yield { type: "done", finishReason: "stop", usage };
      } else yield* model.stream(messages, signal, tools);
    },
  }));
  enable();
  id = (await add("人工确认日志目录", "日志归档约定")).id;
  const s = await history();
  const j = await app!.memories.jobs.create(s.id, "protected");
  expect((await waitJob(j.id)).status).toBe("failed");
  expect(app!.memories.entries()[0]?.text).toBe("人工确认日志目录");
});
it("有效项目偏好优先，正文元数据不会被粗暴截断", () => {
  const make = (
    id: string,
    project: string | null,
    kind: MemoryEntry["kind"],
  ): MemoryEntry => ({
    id,
    title: id,
    text: "有效信息",
    project,
    kind,
    revision: 1,
    manual: false,
    status: "active",
    sources: [],
    createdAt: "2026-09-26T00:00:00Z",
    updatedAt: "2026-09-26T00:00:00Z",
  });
  const selected = memoryOverviewEntries(
    [
      make("other", "/b", "project"),
      make("here", "/a", "project"),
      make("preference", null, "preference"),
    ],
    "/a",
    2500,
  );
  expect(selected.map((e) => e.entry.id)).toEqual([
    "preference",
    "here",
    "other",
  ]);
  expect(selected[2]?.text).not.toContain("有效信息");
});
it("自动提炼不回溯首次开启前历史，显式选择可以整理旧会话", async () => {
  let clock = Date.now() + 60000;
  await setup(
    () => model,
    dir(),
    () => clock,
  );
  const s = await history();
  const settings = enable();
  app!.memories.saveSettings({
    ...settings,
    idleMinutes: 0,
    expectedRevision: settings.revision,
  });
  clock += 3600000;
  await app!.memories.jobs.scan();
  expect(app!.store.memory.list("jobs")).toHaveLength(0);
  const job = await app!.memories.jobs.create(s.id, "backfill");
  expect((await waitJob(job.id)).status).toBe("completed");
});
it("会话读取和贡献独立控制，前台活动时不启动后台模型", async () => {
  await setup();
  enable();
  await add();
  const source = await history();
  const other = await history();
  app!.memories.saveSession(other.id, {
    expectedRevision: 0,
    useMemories: false,
    contributeMemories: true,
  });
  await expect(app!.memories.search({}, other.id)).rejects.toMatchObject({
    code: "memory_disabled",
  });
  const active = app!.store.beginRun({
    sessionId: other.id,
    expectedRevision: app!.store.snapshot(other.id).session.revision,
    requestId: "active",
    fingerprint: "x",
    kind: "send",
    content: "正在处理",
    model: "fixture",
    contextTrimmed: false,
  });
  const job = await app!.memories.jobs.create(source.id, "foreground");
  app!.memories.jobs.kick();
  await new Promise((r) => setTimeout(r, 20));
  expect(app!.store.memory.get("jobs", job.id)?.requests).toBe(0);
  app!.store.finishRun(active.id, {
    status: "succeeded",
    finishReason: "stop",
    usage,
    error: null,
  });
  expect((await waitJob(job.id)).status).toBe("completed");
});
it("任务等待配额后继续保持原模型协议快照", async () => {
  const protocols: string[] = [];
  const a = await setup((...args: unknown[]) => {
    protocols.push((args[0] as { apiProtocol: string })?.apiProtocol);
    return model;
  });
  const s = enable();
  a.memories.saveSettings({
    ...s,
    dailyRequests: 1,
    expectedRevision: s.revision,
  });
  const h = await history();
  const j = await a.memories.jobs.create(h.id, "snapshot");
  await waitJob(j.id);
  const modelSettings = a.settings.get();
  a.settings.save({
    ...modelSettings,
    apiProtocol: "chat_completions",
    expectedRevision: modelSettings.revision,
  });
  const policy = a.memories.settings();
  a.memories.saveSettings({
    ...policy,
    dailyRequests: 20,
    expectedRevision: policy.revision,
  });
  a.memories.jobs.retry(j.id);
  expect((await waitJob(j.id)).status).toBe("completed");
  expect(protocols.slice(-2)).toEqual(["responses", "responses"]);
});
it("超时终结不合作模型且没有自动重试", async () => {
  await setup(() => ({
    async *stream() {
      await new Promise(() => {});
      yield { type: "text", text: "迟到" };
    },
  }));
  const s = enable();
  app!.memories.saveSettings({
    ...s,
    requestTimeoutMs: 100,
    expectedRevision: s.revision,
  });
  const h = await history();
  const j = await app!.memories.jobs.create(h.id, "timeout");
  expect((await waitJob(j.id)).status).toBe("failed");
  expect(app!.store.memory.get("jobs", j.id)?.requests).toBe(1);
  app!.memories.jobs.kick();
  await new Promise((r) => setTimeout(r, 30));
  expect(app!.store.memory.get("jobs", j.id)?.requests).toBe(1);
});
it("格式异常、工具调用和不完整终态不能发布为长期记忆", async () => {
  await setup(() => ({
    async *stream() {
      yield { type: "text", text: '{"memories":[]}' };
      yield { type: "done", finishReason: "length", usage };
    },
  }));
  enable();
  const h = await history();
  const j = await app!.memories.jobs.create(h.id, "incomplete");
  expect((await waitJob(j.id)).status).toBe("failed");
  expect(app!.memories.entries()).toEqual([]);
});
it("文件来源为受保护数据路径；手工保存脱敏、撤销变更恢复且版本递增", async () => {
  await setup();
  const entry = await add("api_key=sk-testlongcredential123456");
  expect(entry.text).not.toContain("sk-test");
  const deleted = await app!.memories.update({
    action: "forget",
    requestId: "del",
    id: entry.id,
    expectedRevision: entry.revision,
  });
  expect(deleted).toBeNull();
  const view = await app!.memories.overview();
  await app!.memories.undo(view.changes[0]!.id, view.revision, "undo");
  expect(app!.memories.entries()[0]?.id).toBe(entry.id);
  expect(app!.memories.entries()[0]!.revision).toBeGreaterThan(entry.revision);
  const workspace = await app!.projects.prepare(dir());
  await expect(
    app!.registry.prepare(
      "read_file",
      JSON.stringify({ path: app!.memories.files.paths.memory }),
      { sessionId: "s", runId: "r", stepId: "t", invocationId: "i", workspace },
    ),
  ).rejects.toMatchObject({ code: "protected_path" });
});

it("后台发布落盘期间取消会回滚，恢复不会启用迟到记忆", async () => {
  const a = await setup();
  enable();
  const session = await history();
  let cancelled = false;
  const files = new LocalMemoryFiles(
    a.memories.files.paths.memory.replace(/\/memories\/MEMORY.md$/, ""),
    () => {
      if (!cancelled) {
        cancelled = true;
        service.jobs.cancel("publish-cancel");
      }
    },
  );
  const service = new MemoryService(
    a.store.memory,
    files,
    a.store,
    a.store.execution,
    a.settings,
  );
  service.historyReader = a.memories.historyReader;
  await service.jobs.create(session.id, "publish-cancel");
  service.jobs.kick();
  for (let i = 0; i < 100 && !cancelled; i++)
    await new Promise((r) => setTimeout(r, 5));
  await service.close();
  await service.initialize();
  expect(a.store.memory.get("jobs", "publish-cancel")?.status).toBe(
    "cancelled",
  );
  expect(service.entries()).toEqual([]);
  expect((await files.read()).entries).toEqual([]);
});
it("会话来源在模型返回前变化，旧候选不能发布", async () => {
  let finish: () => void = () => {};
  const waiting = new Promise<void>((r) => {
    finish = r;
  });
  await setup(() => ({
    async *stream(m, s, t) {
      await waiting;
      yield* model.stream(m, s, t);
    },
  }));
  enable();
  const session = await history();
  const job = await app!.memories.jobs.create(session.id, "changed");
  app!.memories.jobs.kick();
  for (
    let i = 0;
    i < 100 && !app!.store.memory.get("jobs", job.id)?.requests;
    i++
  )
    await new Promise((r) => setTimeout(r, 5));
  const run = app!.store.beginRun({
    sessionId: session.id,
    expectedRevision: app!.store.snapshot(session.id).session.revision,
    requestId: "new",
    fingerprint: "new",
    kind: "send",
    content: "新的修正",
    model: "fixture",
    contextTrimmed: false,
  });
  app!.store.finishRun(run.id, {
    status: "succeeded",
    finishReason: "stop",
    usage,
    error: null,
  });
  finish();
  expect((await waitJob(job.id)).status).toBe("stale");
  expect(app!.memories.entries()).toEqual([]);
});
it("重启将未完成的付费请求标为中断，用量未知且不自动重试", async () => {
  let calls = 0;
  const a = await setup(() => ({
    async *stream() {
      calls++;
      yield { type: "text", text: "unused" };
    },
  }));
  enable();
  const session = await history();
  const job = await a.memories.jobs.create(session.id, "crashed");
  job.status = "running";
  job.requests = 1;
  job.callRecords = [
    {
      id: "call",
      phase: "extract",
      startedAt: a.memories.timestamp(),
      endedAt: null,
      usage: null,
      status: "running",
    },
  ];
  a.store.memory.put("jobs", job);
  a.store.memory.put("usage", {
    id: a.memories.timestamp().slice(0, 10),
    requests: 1,
    usage,
  });
  await a.memories.initialize();
  await a.memories.maintain();
  await new Promise((r) => setTimeout(r, 10));
  expect(a.store.memory.get("jobs", job.id)?.status).toBe("interrupted");
  expect((await a.memories.overview()).usage).toBeNull();
  expect(calls).toBe(0);
});
it("超长来源列表与正文均可续读，不把冲突条目提供给模型", async () => {
  const a = await setup();
  enable();
  const session = await history();
  const entry = await add("资料".repeat(5000));
  const sources = Array.from({ length: 25 }, (_, i) => ({
    id: `source-${i}`,
    sessionId: session.id,
    recordId: `record-${i}`,
    hash: "hash",
    createdAt: a.memories.timestamp(),
    status: "succeeded",
  }));
  const changed = { ...entry, sources, status: "needs_review" as const };
  a.store.memory.put("entries", changed);
  // 这里仅构造有效索引元数据，不模拟来自不同文件的未确认发布。
  let cursor: string | undefined;
  let text = "";
  const seen = new Set<string>();
  do {
    const page = await a.memories.readEntry(entry.id, cursor);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(8000);
    text += page.text;
    for (const source of page.entry.sources) seen.add(source.id);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(text).toBe(entry.text);
  expect(seen.size).toBe(25);
  expect((await a.memories.search({}, session.id)).entries).toEqual([]);
  expect((await a.memories.search()).entries[0]?.status).toBe("needs_review");
});
it("长会话按完整记录分块，每个调用都有独立用量和可恢复进度", async () => {
  const a = await setup();
  enable();
  const session = await history("约定：" + "较长来源".repeat(1900));
  for (let i = 0; i < 8; i++) {
    const run = a.store.beginRun({
      sessionId: session.id,
      expectedRevision: a.store.snapshot(session.id).session.revision,
      requestId: `long-${i}`,
      fingerprint: `long-${i}`,
      kind: "send",
      content: "阶段约定：" + "长来源".repeat(2000),
      model: "fixture",
      contextTrimmed: false,
    });
    a.store.finishRun(run.id, {
      status: "succeeded",
      finishReason: "stop",
      usage,
      error: null,
    });
  }
  const job = await a.memories.jobs.create(session.id, "chunks");
  const done = await waitJob(job.id);
  expect(done.status).toBe("completed");
  const stored = a.store.memory.get("jobs", job.id)!;
  expect(stored.nextChunk).toBeGreaterThan(1);
  expect(stored.callRecords.length).toBe(done.requests);
  expect(done.usage?.totalTokens).toBe(done.requests * 15);
});
it.each(["json", "tool"])(
  "%s 异常模型结果不发布且同输入不自动重发",
  async (kind) => {
    await setup(() => ({
      async *stream() {
        yield {
          type: "text",
          text: kind === "json" ? "invalid" : '{"memories":[]}',
        };
        yield {
          type: "done",
          finishReason: "stop",
          usage,
          response: {
            content: "",
            toolCalls:
              kind === "tool"
                ? [{ id: "x", name: "unexpected", arguments: "{}" }]
                : [],
          },
        };
      },
    }));
    enable();
    const h = await history();
    const j = await app!.memories.jobs.create(h.id, kind);
    expect((await waitJob(j.id)).status).toBe("failed");
    expect((await app!.memories.jobs.create(h.id, "again")).requests).toBe(1);
    expect(app!.memories.entries()).toEqual([]);
  },
);

it("自动整理只选取未处理来源；旧内容不会随新增消息重复付费提炼", async () => {
  const a = await setup();
  enable();
  const session = await history();
  const first = await a.memories.jobs.create(
    session.id,
    "incremental-one",
    false,
  );
  expect((await waitJob(first.id)).status).toBe("completed");
  const prior = new Set(a.store.memory.get("jobs", first.id)!.coveredSourceIds);
  await a.memories.jobs.scan();
  expect(a.store.memory.list("jobs")).toHaveLength(1);
  const run = a.store.beginRun({
    sessionId: session.id,
    expectedRevision: a.store.snapshot(session.id).session.revision,
    requestId: "more",
    fingerprint: "more",
    kind: "send",
    content: "补充：日志保留七天",
    model: "fixture",
    contextTrimmed: false,
  });
  a.store.finishRun(run.id, {
    status: "succeeded",
    finishReason: "stop",
    usage,
    error: null,
  });
  const second = await a.memories.jobs.create(
    session.id,
    "incremental-two",
    false,
  );
  expect(second.input.length).toBeGreaterThan(0);
  expect(second.input.every((r) => !prior.has(r.source.id))).toBe(true);
});
it("多来源条目撤销一个会话后先隐藏，并可依据剩余会话重建", async () => {
  const a = await setup(() => ({
    async *stream(messages, signal, tools) {
      if (messages[0]!.content.includes("第二阶段")) {
        const data = JSON.parse(messages[1]!.content);
        const old = data.existing[0];
        const text = JSON.stringify({
          actions: data.candidates.map(
            (c: { candidateIndex: number; title: string; text: string }) => ({
              ...c,
              action: old ? "merge" : "add",
              ...(old ? { targetId: old.id } : {}),
            }),
          ),
        });
        yield { type: "text", text };
        yield { type: "done", finishReason: "stop", usage };
      } else yield* model.stream(messages, signal, tools);
    },
  }));
  enable();
  const first = await history();
  const second = await history();
  await waitJob((await a.memories.jobs.create(first.id, "source-one")).id);
  await waitJob((await a.memories.jobs.create(second.id, "source-two")).id);
  expect(a.memories.entries()).toHaveLength(1);
  expect(a.memories.entries()[0]?.sources).toHaveLength(2);
  await a.chat.deleteSession(first.id);
  expect(a.memories.entries()[0]?.status).toBe("needs_review");
  expect((await a.memories.search({}, second.id)).entries).toEqual([]);
  await a.memories.jobs.scan();
  const rebuild = a.store.memory
    .list("jobs")
    .find((j) => j.status === "queued")!;
  expect((await waitJob(rebuild.id)).status).toBe("completed");
  expect(a.memories.entries()[0]?.status).toBe("active");
  expect(
    a.memories.entries()[0]?.sources.every((s) => s.sessionId === second.id),
  ).toBe(true);
});
it("合并失败后已有记忆被人工修改，明确重试保留最新正文", async () => {
  let fail = true;
  await setup(() => ({
    async *stream(messages, signal, tools) {
      if (fail && messages[0]!.content.includes("第二阶段")) {
        fail = false;
        throw Error("fixture failure");
      }
      yield* model.stream(messages, signal, tools);
    },
  }));
  enable();
  const session = await history();
  const job = await app!.memories.jobs.create(session.id, "resume");
  expect((await waitJob(job.id)).status).toBe("failed");
  const manual = await add("人工新增加的知识不能丢失", "独立正文");
  app!.memories.jobs.retry(job.id);
  expect((await waitJob(job.id)).status).toBe("completed");
  expect(app!.memories.entries().find((e) => e.id === manual.id)?.text).toBe(
    manual.text,
  );
});

it("落盘前故障撤销提交意图，用户仍能修复并继续保存", async () => {
  const a = await setup();
  const original = a.memories.files.write.bind(a.memories.files);
  let fail = true;
  a.memories.files.write = async (...args) => {
    if (fail) {
      fail = false;
      throw Error("before write");
    }
    return original(...args);
  };
  await expect(add()).rejects.toThrow("before write");
  expect(a.store.memory.list("commits")).toHaveLength(0);
  await add("修复后可保存");
  expect((await a.memories.search()).entries[0]?.text).toBe("修复后可保存");
});

it("新增不能携带已有 ID 绕过人工条目的版本检查", async () => {
  await setup();
  const entry = await add();
  await expect(
    app!.memories.update({
      action: "add",
      id: entry.id,
      title: "试图替换",
      text: "错误正文",
      requestId: "add-overwrite",
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(app!.memories.entries()[0]?.text).toBe(entry.text);
});

it("上下文压缩之后仍带同一记忆快照，不把记忆追加成重复副本", async () => {
  const inputs: string[] = [];
  let summaries = 0;
  await setup(() => ({
    async *stream(messages) {
      const question =
        messages.findLast((m) => m.role === "user")?.content ?? "";
      const compact =
        question.includes('"previousSummary"') &&
        question.includes('"records"');
      if (compact) summaries++;
      else inputs.push(messages[0]!.content);
      const text = compact
        ? "早期任务已核对归档规则，完整细节仍在历史。"
        : question === "继续"
          ? "继续完成。"
          : "已确认的工作事实。".repeat(3000);
      yield { type: "text", text };
      yield { type: "done", finishReason: "stop", usage };
    },
  }));
  enable();
  await add("稳定记忆标记：输出先说明结论。");
  const modelSettings = app!.settings.get();
  app!.settings.save({
    ...modelSettings,
    contextWindowTokens: 32768,
    outputReserveTokens: 4096,
    expectedRevision: modelSettings.revision,
  });
  const session = await app!.projects.create({
    requestId: crypto.randomUUID(),
  });
  for (const content of ["产生较长工作记录", "继续"]) {
    const start = app!.chat.start(session.id, {
      requestId: crypto.randomUUID(),
      expectedRevision: app!.store.snapshot(session.id).session.revision,
      content,
    });
    for (
      let i = 0;
      i < 200 &&
      ["running", "queued"].includes(app!.store.getRun(start.run.id).status);
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    expect(app!.store.getRun(start.run.id).status).toBe("succeeded");
  }
  expect(summaries).toBeGreaterThan(0);
  expect(inputs).toHaveLength(2);
  expect(
    inputs.every((text) => text.split("稳定记忆标记").length - 1 === 1),
  ).toBe(true);
});

it("v6 原聊天数据升级到当前版本，默认关闭且不在启动时调用模型", async () => {
  const dataDir = dir();
  const a = await setup(() => model, dataDir);
  const session = await history("旧版本历史必须保留");
  const before = a.store.snapshot(session.id);
  await a.server.close();
  app = undefined;
  const db = new DatabaseSync(join(dataDir, "state.db"));
  db.exec(
    "DROP TABLE observation_records; DROP TABLE observation_settings; DROP TABLE observation_operations; DROP TABLE team_records; ALTER TABLE sessions DROP COLUMN parent_session_id; ALTER TABLE messages DROP COLUMN origin; DROP TABLE plugin_records; DROP TABLE hook_records; DROP TABLE skill_records; DROP TABLE memory_records; PRAGMA user_version = 6",
  );
  db.close();
  let calls = 0;
  app = await buildServer({
    dataDir,
    serveWeb: false,
    modelFactory: () => {
      calls++;
      return model;
    },
  });
  expect(app.store.snapshot(session.id)).toEqual(before);
  expect(app.memories.settings().enabled).toBe(false);
  expect(app.memories.entries()).toEqual([]);
  expect(calls).toBe(0);
  const check = new DatabaseSync(join(dataDir, "state.db"));
  expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(13);
  check.close();
});
