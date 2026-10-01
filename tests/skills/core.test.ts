/** Skill 集成验证：真实临时文件/SQLite，模型替身只验证请求组成与状态，不冒充真实服务兼容性。 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import {
  OpenAIChatModel,
  OpenAIResponsesModel,
} from "../../packages/adapters/src/index.js";
import { LocalSkillFiles } from "../../packages/adapters/src/skills/files.js";
import type { SkillSource } from "../../packages/contracts/src/index.js";
import { explicitSkills } from "../../packages/extensions/src/index.js";
import type {
  ModelMessage,
  ModelPort,
} from "../../packages/kernel/src/index.js";
import { evaluatePermissions } from "../../packages/kernel/src/index.js";
import { mockProvider } from "../chat/provider.js";

const roots: string[] = [];
const root = () => {
  const path = realpathSync(
    mkdtempSync(join(tmpdir(), "myagent-skills-test-")),
  );
  roots.push(path);
  return path;
};
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
const files: LocalSkillFiles[] = [];
afterEach(async () => {
  if (app) {
    await app.server.close();
    app.skills.files.collect(new Set());
    app = undefined;
  }
  for (const f of files) {
    f.close();
    f.collect(new Set());
  }
  files.length = 0;
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function skill(
  directory: string,
  name = "report",
  body = "技能必须使用标记 ORBIT_73。",
  implicit = true,
) {
  const path = join(directory, name);
  mkdirSync(join(path, "references"), { recursive: true });
  mkdirSync(join(path, "scripts"));
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: 按项目规范汇总销售数据和生成报告\n---\n${body}`,
  );
  writeFileSync(
    join(path, "references/rules.md"),
    "核验依据：使用人民币，按月份汇总。",
  );
  writeFileSync(
    join(path, "scripts/check.sh"),
    '#!/bin/sh\nprintf "verified" > result.txt\n',
  );
  if (!implicit) {
    mkdirSync(join(path, "agents"));
    writeFileSync(
      join(path, "agents/openai.yaml"),
      "policy:\n  allow_implicit_invocation: false\ninterface:\n  display_name: 中文技能\n",
    );
  }
  return path;
}
function adapter(limits?: {
  fileBytes: number;
  packageBytes: number;
  files: number;
}) {
  const dir = root(),
    source = join(dir, "source");
  mkdirSync(source);
  const f = new LocalSkillFiles(join(dir, "data"), [], limits);
  files.push(f);
  const definition: SkillSource = {
    id: "source",
    path: source,
    scope: "user",
    workspaceId: null,
    enabled: true,
    builtin: false,
    revision: 0,
  };
  return { dir, source, f, definition };
}
const done = (text = "完成") => ({
  type: "done" as const,
  finishReason: "stop" as const,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  response: { content: text, toolCalls: [] },
});
const direct: ModelPort = {
  async *stream() {
    yield done();
  },
};
async function setup(
  model: ModelPort = direct,
  directory = root(),
  extra: Record<string, unknown> = {},
) {
  const skillRoot = join(directory, "skills");
  mkdirSync(skillRoot, { recursive: true });
  app = await buildServer({
    dataDir: join(directory, "data"),
    workspaceRoot: join(directory, "work"),
    skillRoot,
    serveWeb: false,
    modelFactory: () => model,
    ...extra,
  });
  if (!app.settings.get().configured)
    app.settings.save({
      baseUrl: "http://127.0.0.1:1/v1",
      apiProtocol: "responses",
      model: "fixture",
      apiKey: "fixture-key",
      systemPrompt: "",
      expectedRevision: 0,
    });
  return { app, directory, skillRoot };
}
async function wait(id: string) {
  for (let i = 0; i < 600; i++) {
    const r = app!.store.getRun(id);
    if (!["queued", "running"].includes(r.status)) return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run timed out");
}
async function start(
  content = "汇总销售数据",
  skillIds?: string[],
  sessionId?: string,
) {
  const session = sessionId
    ? app!.store.snapshot(sessionId).session
    : await app!.projects.create({ requestId: crypto.randomUUID() });
  const accepted = app!.chat.start(session.id, {
    requestId: crypto.randomUUID(),
    expectedRevision: session.revision,
    content,
    ...(skillIds ? { skillIds } : {}),
  });
  return { ...accepted, end: await wait(accepted.run.id) };
}
it("独立来源与项目目录发现，同名不合并且非法格式不污染其他技能", async () => {
  const { skillRoot, directory } = await setup();
  skill(skillRoot);
  const work = join(directory, "project");
  mkdirSync(work);
  skill(join(work, ".myagent/skills"));
  const project = await app!.projects.prepare(work);
  const catalog = app!.skills.catalog(project.id);
  expect(catalog.entries).toHaveLength(2);
  expect(new Set(catalog.entries.map((e) => e.id)).size).toBe(2);
  expect(() => explicitSkills("使用 $report", catalog.entries)).toThrow(
    "多个来源",
  );
  const bad = skill(skillRoot, "broken");
  writeFileSync(join(bad, "SKILL.md"), "broken yaml");
  expect(
    app!.skills.catalog().entries.find((e) => e.name === "broken")?.error,
  ).toBeTruthy();
  const count = app!.store.listSessions().length;
  expect(
    (await app!.server.inject({ method: "GET", url: "/api/v1/skills" }))
      .statusCode,
  ).toBe(200);
  expect(app!.store.listSessions()).toHaveLength(count);
});
it("显式语法忽略代码与转义，结构化 ID 支持同名消歧", () => {
  const { f, source, definition } = adapter();
  skill(source);
  const entries = f.scan(definition);
  expect(
    explicitSkills("`$report`\n```sh\n$report\n```\n\\$report", entries),
  ).toEqual([]);
  expect(explicitSkills("请用 $report", entries)).toEqual([entries[0]!.id]);
  expect(
    explicitSkills(
      "$report",
      [...entries, { ...entries[0]!, id: "other" }],
      ["other"],
    ),
  ).toEqual(["other"]);
});
it("显式选择首请求完整注入超 8000 字符正文，且下一 Run 不自动继承", async () => {
  const received: ModelMessage[][] = [];
  const { skillRoot } = await setup({
    async *stream(messages) {
      received.push(structuredClone([...messages]));
      yield done();
    },
  });
  skill(skillRoot, "report", `${"规范".repeat(6000)}\nEND_OF_SKILL`);
  const entry = app!.skills.catalog().entries[0]!;
  const first = await start("请汇总", [entry.id]);
  expect(first.end.status).toBe("succeeded");
  expect(JSON.stringify(received[0])).toContain("END_OF_SKILL");
  expect(app!.contexts.view(first.run.sessionId)?.skills?.active).toHaveLength(
    1,
  );
  const second = await start("你好", undefined, first.run.sessionId);
  expect(second.end.status).toBe("succeeded");
  expect(JSON.stringify(received[1])).not.toContain("END_OF_SKILL");
});
it("自主加载、读取参考资料、多次请求与重复加载只注入一份正文", async () => {
  let id = "",
    requests = 0;
  const bodies: string[] = [];
  const { skillRoot } = await setup({
    async *stream(messages) {
      requests++;
      bodies.push(JSON.stringify(messages));
      const toolCalls =
        requests <= 2
          ? [
              {
                id: `load-${requests}`,
                name: "load_skill",
                arguments: JSON.stringify({ id }),
              },
            ]
          : requests === 3
            ? [
                {
                  id: "read",
                  name: "read_skill_resource",
                  arguments: JSON.stringify({
                    id,
                    path: "references/rules.md",
                  }),
                },
              ]
            : [];
      yield {
        ...done(),
        finishReason: toolCalls.length ? "tool_calls" : "stop",
        response: { content: toolCalls.length ? "" : "完成", toolCalls },
      };
    },
  });
  skill(skillRoot);
  id = app!.skills.catalog().entries[0]!.id;
  const run = await start();
  expect(run.end.status, JSON.stringify(run.end.error)).toBe("succeeded");
  expect(requests).toBe(4);
  expect(
    bodies.slice(1).every((text) => text.split("ORBIT_73").length === 2),
  ).toBe(true);
  expect(bodies[3]).toContain("人民币");
  const record = app!.store.skills.get("runs", run.run.id)!;
  expect(record.active).toHaveLength(1);
  expect(
    app!.store.execution
      .list("invocations", { runId: run.run.id })
      .every((i) => i.status === "succeeded"),
  ).toBe(true);
});
it("技能启停和外部内容变更从下轮生效，在途使用持久副本", async () => {
  let id = "",
    path = "",
    calls = 0;
  const observations: string[] = [];
  const { skillRoot } = await setup({
    async *stream(messages) {
      calls++;
      observations.push(JSON.stringify(messages));
      if (calls === 1) {
        writeFileSync(
          join(path, "SKILL.md"),
          "---\nname: report\ndescription: 已更新\n---\nNEW_VERSION",
        );
        app!.skills.setEnabled(id, false);
      }
      yield {
        ...done(),
        response: {
          content: calls === 1 ? "" : "完成",
          toolCalls:
            calls === 1
              ? [{ id: "time", name: "get_current_time", arguments: "{}" }]
              : [],
        },
        finishReason: calls === 1 ? "tool_calls" : "stop",
      };
    },
  });
  path = skill(skillRoot);
  id = app!.skills.catalog().entries[0]!.id;
  const run = await start("统计", [id]);
  expect(run.end.status, JSON.stringify(run.end.error)).toBe("succeeded");
  expect(observations[1]).toContain("ORBIT_73");
  expect(observations[1]).not.toContain("NEW_VERSION");
  const next = await start("你好");
  expect(next.end.status).toBe("succeeded");
  expect(observations[2]).not.toContain("ORBIT_73");
});
it("主说明在目录冻结后修改，按需加载返回明确错误", async () => {
  let id = "",
    path = "",
    calls = 0;
  const { skillRoot } = await setup({
    async *stream() {
      calls++;
      if (calls === 1)
        writeFileSync(
          join(path, "SKILL.md"),
          "---\nname: report\ndescription: new\n---\n新版本",
        );
      yield {
        ...done(),
        response: {
          content: calls === 1 ? "" : "完成",
          toolCalls:
            calls === 1
              ? [
                  {
                    id: "load",
                    name: "load_skill",
                    arguments: JSON.stringify({ id }),
                  },
                ]
              : [],
        },
        finishReason: calls === 1 ? "tool_calls" : "stop",
      };
    },
  });
  path = skill(skillRoot);
  id = app!.skills.catalog().entries[0]!.id;
  const run = await start();
  expect(run.end.status, JSON.stringify(run.end.error)).toBe("succeeded");
  expect(
    app!.store.execution.list("invocations", { runId: run.run.id })[0]?.result
      ?.error?.code,
  ).toBe("skill_changed");
  expect(app!.store.skills.get("runs", run.run.id)?.active).toEqual([]);
});
it("仅明确调用策略不进入自主目录，但用户指定可以加载", async () => {
  const requests: string[] = [];
  const { skillRoot } = await setup({
    async *stream(m) {
      requests.push(JSON.stringify(m));
      yield done();
    },
  });
  skill(skillRoot, "report", "EXPLICIT_ONLY", false);
  const id = app!.skills.catalog().entries[0]!.id;
  await start();
  expect(requests[0]).not.toContain("report");
  await start("使用技能", [id]);
  expect(requests[1]).toContain("EXPLICIT_ONLY");
});
it("64 KiB 主说明与包容量边界拒绝，不静默截断", async () => {
  const { f, source, definition } = adapter({
    fileBytes: 50,
    packageBytes: 100,
    files: 1,
  });
  const p = skill(source);
  const entry = f.scan(definition)[0]!;
  await expect(f.capture(entry, new AbortController().signal)).rejects.toThrow(
    "上限",
  );
  writeFileSync(join(p, "SKILL.md"), "x".repeat(65537));
  expect(f.scan(definition)[0]?.error).toContain("64 KiB");
});
it("越界链接、特殊路径、二进制资源和长文本分页", async () => {
  const { f, source, definition, dir } = adapter();
  const p = skill(source);
  writeFileSync(join(p, "references/long.txt"), "日志".repeat(12000));
  writeFileSync(join(p, "assets.bin"), Buffer.from([0, 255, 128]));
  const pkg = await f.capture(
    f.scan(definition)[0]!,
    new AbortController().signal,
  );
  let cursor: string | undefined;
  let text = "";
  do {
    const page = f.read(pkg, "references/long.txt", cursor);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(8000);
    text += page.text;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(text).toBe("日志".repeat(12000));
  expect(f.read(pkg, "assets.bin").binary).toBe(true);
  expect(() => f.read(pkg, "../state.db")).toThrow();
  writeFileSync(join(dir, "secret"), "PRIVATE");
  symlinkSync(join(dir, "secret"), join(p, "leak"));
  await expect(
    f.capture(f.scan(definition)[0]!, new AbortController().signal),
  ).rejects.toThrow("链接");
});
it("持久快照恢复不读取已变化的源文件，资源查询只能访问本轮已加载包", async () => {
  const { directory, skillRoot } = await setup();
  const path = skill(skillRoot);
  const id = app!.skills.catalog().entries[0]!.id;
  const run = await start("统计", [id]);
  const active = app!.store.skills.get("runs", run.run.id)!.active[0]!;
  expect(() => app!.skills.resource(run.run.id, "other", "SKILL.md")).toThrow(
    "先加载",
  );
  await app!.server.close();
  app = undefined;
  writeFileSync(join(path, "SKILL.md"), "changed");
  await setup(direct, directory);
  expect(app!.skills.resource(run.run.id, id, "SKILL.md").text).toContain(
    "ORBIT_73",
  );
  expect(
    app!.store.skills.get("runs", run.run.id)?.active[0]?.packageVersion,
  ).toBe(active.packageVersion);
});
it("重复请求含技能选择指纹，重新生成继承显式选择且不会跨会话继承", async () => {
  const { skillRoot } = await setup();
  skill(skillRoot);
  const id = app!.skills.catalog().entries[0]!.id;
  const s = await app!.projects.create({ requestId: crypto.randomUUID() });
  const input = {
    requestId: "same",
    expectedRevision: s.revision,
    content: "统计",
    skillIds: [id],
  };
  const first = app!.chat.start(s.id, input);
  await wait(first.run.id);
  expect(app!.chat.start(s.id, input).run.id).toBe(first.run.id);
  expect(() => app!.chat.start(s.id, { ...input, skillIds: [] })).toThrow(
    "标识",
  );
  const regen = app!.chat.start(
    s.id,
    {
      requestId: "regen",
      expectedRevision: app!.store.snapshot(s.id).session.revision,
    },
    "regenerate",
  );
  await wait(regen.run.id);
  expect(app!.store.skills.get("runs", regen.run.id)?.selected).toEqual([id]);
  const other = await start();
  expect(app!.store.skills.get("runs", other.run.id)?.active).toEqual([]);
});
it("必要技能正文放不下则暂停，调整容量继续不重放技能工具", async () => {
  const { skillRoot } = await setup();
  skill(skillRoot, "report", "指令".repeat(9000));
  const settings = app!.settings.get();
  app!.settings.save({
    ...settings,
    contextWindowTokens: 8192,
    outputReserveTokens: 1024,
    expectedRevision: settings.revision,
  });
  const id = app!.skills.catalog().entries[0]!.id;
  const run = await start("你好", [id]);
  expect(run.end.status).toBe("waiting_context");
  expect(
    app!.contexts.view(run.run.sessionId)?.stats?.breakdown.skills,
  ).toBeGreaterThan(8000);
  expect(app!.contexts.view(run.run.sessionId)?.error?.message).toContain(
    "技能",
  );
  const current = app!.settings.get();
  app!.settings.save({
    ...current,
    contextWindowTokens: 200000,
    expectedRevision: current.revision,
  });
  await app!.chat.resume(run.run.id, {
    contextAction: "apply_capacity",
    requestId: "resize",
  });
  expect((await wait(run.run.id)).status).toBe("succeeded");
  expect(app!.store.skills.get("runs", run.run.id)?.active).toHaveLength(1);
});
it("目录预算截短但完整目录可搜索分页查回", async () => {
  const { skillRoot } = await setup();
  for (let i = 0; i < 45; i++) skill(skillRoot, `skill-${i}`, "说明");
  const s = await app!.projects.create({ requestId: crypto.randomUUID() });
  const run = app!.store.beginRun({
    sessionId: s.id,
    expectedRevision: s.revision,
    requestId: "manual",
    fingerprint: "m",
    content: "任务",
    kind: "send",
    model: "fixture",
    contextTrimmed: false,
  });
  app!.skills.initialize(run.id, "任务");
  const prepared = await app!.skills.prepare(
    run.id,
    4000,
    new AbortController().signal,
  );
  expect(prepared.view.omitted).toBeGreaterThan(0);
  expect(app!.skills.search(run.id, "skill-44").entries[0]?.name).toBe(
    "skill-44",
  );
  let count = 0,
    cursor: string | undefined;
  do {
    const page = app!.skills.search(run.id, "", cursor);
    count += page.entries.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(count).toBe(45);
});
it("来源管理版本冲突和项目隔离，移除只注销来源", async () => {
  await setup();
  const dir = root();
  skill(dir);
  const source = app!.skills.addSource({ path: dir, scope: "user" });
  expect(app!.skills.catalog().entries).toHaveLength(1);
  app!.skills.changeSource(source.id, { enabled: false, expectedRevision: 0 });
  expect(() =>
    app!.skills.changeSource(source.id, { enabled: true, expectedRevision: 0 }),
  ).toThrow("刷新");
  app!.skills.removeSource(source.id);
  expect(app!.skills.catalog().entries).toEqual([]);
  expect(readFileSync(join(dir, "report/SKILL.md"), "utf8")).toContain(
    "ORBIT_73",
  );
});
it("只读技能范围不授予写/联网，显式拒绝始终优先", () => {
  const common = {
    workspace: null,
    sessionId: "s",
    invocationId: "i",
    fingerprint: "f",
    grants: [],
    trustedReadPaths: ["/skill"],
  };
  expect(
    evaluatePermissions({
      ...common,
      resources: [{ kind: "path", target: "/skill/script", access: "read" }],
    }).decision,
  ).toBe("allow");
  expect(
    evaluatePermissions({
      ...common,
      resources: [{ kind: "path", target: "/skill", access: "write" }],
    }).decision,
  ).toBe("ask");
  expect(
    evaluatePermissions({
      ...common,
      resources: [
        { kind: "network", target: "example.com", access: "connect" },
      ],
    }).decision,
  ).toBe("ask");
});
it("v7 升级 v8 保留聊天，未来版本拒绝且启动不调用模型", async () => {
  const { directory } = await setup();
  const session = app!.store.createSession();
  await app!.server.close();
  app = undefined;
  const db = new DatabaseSync(join(directory, "data/state.db"));
  db.exec(
    "DROP TABLE observation_records; DROP TABLE observation_settings; DROP TABLE observation_operations; DROP TABLE team_records; ALTER TABLE sessions DROP COLUMN parent_session_id; ALTER TABLE messages DROP COLUMN origin; DROP TABLE plugin_records; DROP TABLE hook_records; DROP TABLE skill_records; PRAGMA user_version=7",
  );
  db.close();
  let calls = 0;
  await setup(
    {
      async *stream() {
        calls++;
        yield done();
      },
    },
    directory,
  );
  expect(app!.store.snapshot(session.id).session.id).toBe(session.id);
  expect(calls).toBe(0);
  expect(app!.store.skills.list("runs")).toEqual([]);
});

// 使用真实 HTTP SSE 协议，验证两种适配器都保留独立技能消息与工具配对。
for (const protocol of ["responses", "chat_completions"] as const)
  it(`${protocol} HTTP 技能闭环保持配对与完整正文`, async () => {
    let id = "";
    const provider = await mockProvider(0, (_question, results) => ({
      text: results.length ? "完成" : "",
      calls: results.length
        ? []
        : [
            {
              id: "skill",
              name: "load_skill",
              arguments: JSON.stringify({ id }),
            },
          ],
    }));
    try {
      const model =
        protocol === "responses"
          ? new OpenAIResponsesModel(provider.url, "fake", "test")
          : new OpenAIChatModel(provider.url, "fake", "test");
      const { skillRoot } = await setup(model);
      skill(skillRoot);
      id = app!.skills.catalog().entries[0]!.id;
      const run = await start();
      expect(run.end.status, JSON.stringify(run.end.error)).toBe("succeeded");
      expect(provider.requests).toHaveLength(2);
      expect(JSON.stringify(provider.requests[1])).toContain("ORBIT_73");
    } finally {
      await provider.close();
    }
  });
it("取消后迟到的包捕获不能激活技能", async () => {
  let id = "";
  const { skillRoot } = await setup({
    async *stream() {
      yield {
        ...done(),
        finishReason: "tool_calls",
        response: {
          content: "",
          toolCalls: [
            {
              id: "load",
              name: "load_skill",
              arguments: JSON.stringify({ id }),
            },
          ],
        },
      };
    },
  });
  skill(skillRoot);
  id = app!.skills.catalog().entries[0]!.id;
  const original = app!.skills.files.capture.bind(app!.skills.files);
  let release!: () => void,
    entered = false;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  app!.skills.files.capture = async (...args) => {
    const pkg = await original(...args);
    entered = true;
    await pending;
    return pkg;
  };
  const s = await app!.projects.create({ requestId: crypto.randomUUID() });
  const accepted = app!.chat.start(s.id, {
    requestId: "cancel",
    expectedRevision: s.revision,
    content: "统计",
  });
  await expect.poll(() => entered).toBe(true);
  await app!.chat.cancel(accepted.run.id);
  release();
  await new Promise((r) => setTimeout(r, 30));
  expect(app!.store.skills.get("runs", accepted.run.id)?.active).toEqual([]);
});
it("回执存储失败不发布技能激活", async () => {
  let id = "";
  const { skillRoot } = await setup({
    async *stream() {
      yield {
        ...done(),
        finishReason: "tool_calls",
        response: {
          content: "",
          toolCalls: [
            {
              id: "load",
              name: "load_skill",
              arguments: JSON.stringify({ id }),
            },
          ],
        },
      };
    },
  });
  skill(skillRoot);
  id = app!.skills.catalog().entries[0]!.id;
  app!.toolSystem.options.results.save = async () => {
    throw new Error("storage failure");
  };
  const run = await start();
  expect(run.end.status).toBe("recoverable");
  expect(app!.store.skills.get("runs", run.run.id)?.active).toEqual([]);
});
it("真实上下文压缩后主说明仍完整且只注入一次", async () => {
  let business = 0,
    summaries = 0;
  const inputs: string[] = [];
  const { skillRoot } = await setup(
    {
      async *stream(messages) {
        if (messages[0]?.content.includes("你负责整理 Agent")) {
          summaries++;
          yield done("已经读取时间，继续验证。");
          return;
        }
        business++;
        inputs.push(JSON.stringify(messages));
        const calls =
          business < 5
            ? [
                {
                  id: `time-${business}`,
                  name: "get_current_time",
                  arguments: "{}",
                },
              ]
            : [];
        yield {
          ...done(),
          finishReason: calls.length ? "tool_calls" : "stop",
          response: {
            content: calls.length ? "步骤说明".repeat(300) : "完成",
            toolCalls: calls,
          },
        };
      },
    },
    root(),
    { contextTriggerRatio: 0.01 },
  );
  skill(skillRoot);
  const id = app!.skills.catalog().entries[0]!.id;
  const run = await start("验证压缩", [id]);
  expect(run.end.status, JSON.stringify(run.end.error)).toBe("succeeded");
  expect(summaries).toBeGreaterThan(0);
  expect(inputs.every((t) => t.split("ORBIT_73").length === 2)).toBe(true);
});

it("项目默认技能根不能通过链接读取项目外目录", async () => {
  const { directory } = await setup();
  const work = join(directory, "project-link"),
    outside = root();
  skill(outside);
  mkdirSync(join(work, ".myagent"), { recursive: true });
  symlinkSync(outside, join(work, ".myagent/skills"));
  const project = await app!.projects.prepare(work);
  const entries = app!.skills.catalog(project.id).entries;
  expect(entries.every((e) => !!e.error)).toBe(true);
});
