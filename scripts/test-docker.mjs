/**
 * Docker 产品验收：创建独立 Compose 项目、假模型和测试卷，检查打包、持久化与故障恢复。
 * 包含停止、SIGKILL、备份恢复和资源删除，仅允许作用于本脚本创建的资源。
 * 不读取用户数据或真实密钥；结果与清理状态写入 .cache/acceptance。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const image = process.env.MYAGENT_TEST_IMAGE ?? "myagent:acceptance-v1";
// 唯一项目名及显式 ownedVolumes 集合限定故障注入与删除范围，不复用日常运行的产品卷。
const project = `myagent-acceptance-${Date.now()}`;
const temp = mkdtempSync(join(tmpdir(), `${project}-`));
const file = join(temp, "compose.json");
const fakeKey = "docker-fixture-only-no-real-credential";
const ownedVolumes = new Set();
const report = { date: new Date().toISOString(), image, checks: [] };
function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}
function compose(...args) {
  return docker("compose", "-p", project, "-f", file, ...args);
}
function passed(name) {
  report.checks.push(name);
  console.info(`PASS ${name}`);
}
// 等待可观察到的就绪状态而非固定长睡眠；超时后让 finally 统一回收验收资源。
async function until(check, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(300);
  }
  throw new Error("等待容器验收状态超时");
}
let base;
async function api(path, method = "GET", data) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(5000),
  });
  assert(response.ok, `API ${method} ${path} => ${response.status}`);
  return response.status === 204 ? null : response.json();
}
let container;
// 每次重建都重新读取容器 ID 和随机端口，防止向上一个实例发送验收请求。
async function ready() {
  container = compose("ps", "-q", "myagent").trim();
  await until(
    () =>
      docker(
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        container,
      ).trim() === "healthy",
  );
  const port = compose("port", "myagent", "3000").trim();
  assert(port.startsWith("127.0.0.1:"), "端口没有限制到 loopback");
  base = `http://${port}`;
}
try {
  // 从产品 Compose 派生验收配置，改成唯一资源名与随机 loopback 端口，覆盖真实打包路径。
  const config = JSON.parse(docker("compose", "config", "--format", "json"));
  config.name = project;
  const service = config.services.myagent;
  delete service.build;
  service.image = image;
  service.ports = [
    { target: 3000, published: "0", host_ip: "127.0.0.1", protocol: "tcp" },
  ];
  service.healthcheck = {
    test: [
      "CMD",
      "node",
      "-e",
      "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ],
    interval: "1s",
    timeout: "5s",
    retries: 15,
  };
  // config 渲染会显式指定卷和网络名称，因此重新限定到唯一验收项目。
  for (const [key, value] of Object.entries(config.volumes ?? {})) {
    value.name = `${project}-${key}`;
    ownedVolumes.add(value.name);
  }
  for (const [key, value] of Object.entries(config.networks ?? {}))
    value.name = `${project}-${key}`;
  config.services.provider = {
    image,
    user: "node",
    entrypoint: ["node", "/fixture/provider.mjs"],
    volumes: [
      {
        type: "bind",
        source: resolve("tests/docker/provider.mjs"),
        target: "/fixture/provider.mjs",
        read_only: true,
      },
    ],
    networks: ["default"],
  };
  writeFileSync(file, JSON.stringify(config));
  // 在本脚本拥有的新卷里预置真实 v8 数据库，验证镜像启动自动迁移；不触碰用户卷。
  const seedVolume = config.volumes["myagent-data"].name;
  docker(
    "volume",
    "create",
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    "com.docker.compose.volume=myagent-data",
    seedVolume,
  );
  docker(
    "run",
    "--rm",
    "--user",
    "root",
    "--entrypoint",
    "node",
    "-v",
    `${seedVolume}:/data`,
    image,
    "-e",
    "const fs=require('fs');const {createRequire}=require('module');const req=createRequire('/app/packages/adapters/package.json');const DB=req('better-sqlite3');const db=new DB('/data/state.db');for(const p of fs.readdirSync('/app/migrations').filter(p=>/^00(?:0[1-9]|1[01])_/.test(p)).sort())db.exec(fs.readFileSync('/app/migrations/'+p,'utf8'));db.pragma('user_version=11');db.close();fs.chownSync('/data',1000,1000);fs.chownSync('/data/state.db',1000,1000);fs.chmodSync('/data',448);fs.chmodSync('/data/state.db',384);",
  );
  compose("up", "-d", "--no-build");
  await ready();
  const migrated = docker(
    "exec",
    container,
    "node",
    "-e",
    "const {createRequire}=require('module');const r=createRequire('/app/packages/adapters/package.json');const D=r('better-sqlite3');const db=new D('/data/state.db',{readonly:true});console.log(db.pragma('user_version',{simple:true}));db.close();",
  ).trim();
  assert.equal(migrated, "13");
  passed("真实 v11 数据卷随容器启动升级为 v13");
  const inspect = JSON.parse(docker("inspect", container))[0];
  assert.equal(inspect.Config.User, "node");
  assert(inspect.HostConfig.CapDrop.includes("ALL"));
  assert(
    inspect.HostConfig.SecurityOpt.includes("no-new-privileges:true") ||
      inspect.HostConfig.SecurityOpt.includes("no-new-privileges"),
  );
  report.node = docker("exec", container, "node", "--version").trim();
  report.platform = docker(
    "image",
    "inspect",
    image,
    "--format",
    "{{.Os}}/{{.Architecture}}",
  ).trim();
  passed("Compose 启动、健康检查、普通用户、最小权限与 loopback 映射");
  const html = await (await fetch(base)).text();
  assert(html.includes("MyAgent"));
  const script = html.match(/src="([^"]+\.js)"/)?.[1];
  assert(script);
  assert((await fetch(`${base}${script}`)).ok);
  passed("生产 Web 与 API 统一托管且 JS 资源可加载");
  const settings = await api("/settings");
  assert.equal(settings.hasKey, false);
  let saved = await api("/settings", "PUT", {
    baseUrl: "http://provider:8080/v1",
    model: "test",
    apiKey: fakeKey,
    systemPrompt: "",
    expectedRevision: settings.revision,
  });
  assert(!JSON.stringify(saved).includes(fakeKey));
  const observationSettings = await api("/observability/settings");
  assert.equal(observationSettings.debug, false);
  await api("/observability/settings", "PUT", {
    requestId: crypto.randomUUID(),
    expectedRevision: observationSettings.revision,
    debug: true,
    retentionDays: 30,
  });
  const session = await api("/sessions", "POST", {});
  await api(`/sessions/${session.id}/runs`, "POST", {
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    content: "容器备份恢复验收",
  });
  const complete = await until(async () => {
    const value = await api(`/sessions/${session.id}`);
    return value.latestRun?.status === "succeeded" ? value : null;
  });
  assert.equal(complete.messages[1].content, "容器持久化测试回答");
  const observedCall = (
    await api(`/observability/calls?sessionId=${session.id}`)
  ).items[0];
  const observedCapture = await until(async () => {
    const detail = await api(`/observability/calls/${observedCall.id}`);
    return detail.captures.find(
      (c) => c.direction === "input" && c.status === "complete",
    );
  });
  const captureHash = observedCapture.sha256;
  assert(
    (
      await api(
        `/observability/calls/${observedCall.id}/captures/${observedCapture.id}`,
      )
    ).text.includes("容器备份恢复验收"),
  );
  assert.equal(
    (await api(`/observability/runs/${complete.latestRun.id}`)).usage.requests,
    1,
  );
  passed("v12 原始 HTTP 输入、Trace 与独立调用账本");
  const permissions = JSON.parse(
    docker(
      "exec",
      container,
      "node",
      "-e",
      "const f=require('fs');console.log(JSON.stringify(['/data','/data/state.db','/data/credentials.json'].map(p=>f.statSync(p).mode&511)))",
    ),
  );
  assert.deepEqual(permissions, [0o700, 0o600, 0o600]);
  passed("容器内模型 HTTP 流、SQLite 写入和凭证权限");
  // 用户来源独立卷 + v8 持久快照；容器重启不需要重跑技能或读取宿主目录。
  docker(
    "exec",
    container,
    "node",
    "-e",
    `const f=require('fs');f.mkdirSync('/skills/docker-skill',{recursive:true});f.writeFileSync('/skills/docker-skill/SKILL.md',${JSON.stringify("---\nname: docker-skill\ndescription: 容器技能验收\n---\nDOCKER_SKILL_MARKER")});`,
  );
  const skillEntry = (await api("/skills")).entries.find(
    (e) => e.name === "docker-skill",
  );
  assert(skillEntry && !skillEntry.error);
  const skillSession = await api("/sessions", "POST", {});
  await api(`/sessions/${skillSession.id}/runs`, "POST", {
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    content: "技能快照验收",
    skillIds: [skillEntry.id],
  });
  await until(
    async () =>
      (await api(`/sessions/${skillSession.id}`)).latestRun?.status ===
      "succeeded",
  );
  const skillContext = await api(`/sessions/${skillSession.id}/context`);
  assert.equal(skillContext.skills.active.length, 1);
  passed("Skill 独立卷发现与完整说明激活，不执行额外脚本");
  // 独立项目 Hook 不影响其余验收；Linux 容器禁止嵌套隔离时明确验证拒绝，绝不裸进程降级。
  docker(
    "exec",
    container,
    "node",
    "-e",
    "const f=require('fs');f.mkdirSync('/hooks/docker-check',{recursive:true});f.writeFileSync('/hooks/docker-check/main.mjs','console.log(JSON.stringify({decision:\"continue\",additionalContext:\"DOCKER_HOOK_MARKER\"}));');",
  );
  const hookSession = await api("/sessions", "POST", {});
  const hookTarget = { scope: "project", workspaceId: hookSession.workspaceId };
  const hookBefore = await api(
    `/hooks/config?scope=project&workspaceId=${hookSession.workspaceId}`,
  );
  const hookText = JSON.stringify({
    schemaVersion: 1,
    hooks: [
      {
        id: "docker-check",
        event: "RunStart",
        enabled: true,
        packagePath: "/hooks/docker-check",
        entry: "main.mjs",
        interpreter: "node",
        args: [],
        timeoutMs: 5000,
        permissions: { writePaths: [], networkDomains: [] },
      },
    ],
  });
  const hookPreview = await api("/hooks/config", "PUT", {
    ...hookTarget,
    text: hookText,
    expectedRevision: hookBefore.revision,
  });
  assert.equal(hookPreview.error, null);
  const hookSaved = await api("/hooks/config", "PUT", {
    ...hookTarget,
    text: hookText,
    expectedRevision: hookBefore.revision,
    expectedVersion: hookPreview.version,
  });
  const hookRun = await api(`/sessions/${hookSession.id}/runs`, "POST", {
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    content: "Hook 容器验收",
  });
  const hookFinal = await until(async () => {
    const s = await api(`/sessions/${hookSession.id}`);
    return ["succeeded", "failed"].includes(s.latestRun?.status) ? s : null;
  });
  const hookRecords = await api(`/sessions/${hookSession.id}/hooks`);
  assert.equal(hookRecords.length, 1);
  if (hookFinal.latestRun.status === "succeeded")
    assert.equal(hookRecords[0].output.additionalContext, "DOCKER_HOOK_MARKER");
  else assert.equal(hookRecords[0].error.code, "sandbox_unavailable");
  report.hookSandbox =
    hookFinal.latestRun.status === "succeeded"
      ? "executed"
      : "unavailable_refused";
  assert(hookRun.run.id);
  passed(`Hook 私有入口与配置版本保存；容器沙箱结果 ${report.hookSandbox}`);
  const execution = await api(`/sessions/${session.id}/execution`);
  const commandConfig = await api("/command-policy/config?scope=user");
  const commandSaved = await api("/command-policy/config", "PUT", {
    scope: "user",
    expectedRevision: commandConfig.revision,
    text: JSON.stringify({
      schemaVersion: 1,
      rules: [{ id: "deny-rm", pattern: ["rm"], decision: "deny" }],
    }),
  });
  for (const [command, decision] of [
    ["pwd", "allow"],
    ["rm file", "deny"],
    ["node script.js", "prompt"],
    ["cat file > out", "prompt"],
  ]) {
    const checked = await api("/command-policy/evaluate", "POST", {
      workspaceId: execution.workspace.id,
      command,
    });
    assert.equal(checked.decision, decision);
  }
  passed(
    "生产运行时纯依赖安装后 WASM 可加载，命令规则与复杂语法判断正确且不执行测试命令",
  );
  const taskPath = execution.workspace.path;
  assert(taskPath.startsWith("/workspaces/"));
  docker(
    "exec",
    container,
    "node",
    "-e",
    "require('fs').writeFileSync(require('path').join(process.argv[1], 'persist.txt'), 'workspace-persisted')",
    taskPath,
  );
  const secondSession = await api("/sessions", "POST", {});
  assert.notEqual(secondSession.workspaceId, session.workspaceId);
  await api(`/sessions/${secondSession.id}`, "DELETE");
  const memorySettings = (await api("/memories")).settings;
  const {
    revision: memoryRevision,
    enabledAt: memoryEnabledAt,
    ...memoryPolicy
  } = memorySettings;
  await api("/memories/settings", "PUT", {
    ...memoryPolicy,
    enabled: true,
    generateMemories: false,
    expectedRevision: memoryRevision,
  });
  const memoryEntry = (
    await api("/memories/entries", "POST", {
      action: "add",
      requestId: crypto.randomUUID(),
      title: "容器记忆",
      text: "长期记忆应随数据卷恢复。",
      kind: "experience",
    })
  ).entry;
  // 插件持久包独立于示例来源；安装仅 Skill 部分，容器沙箱另外核验拒绝行为。
  const pluginJob = await api("/plugins/preview", "POST", {
    scope: "user",
    requestId: crypto.randomUUID(),
    action: "install",
    expectedRevision: 0,
    enabled: true,
    source: { kind: "local", path: "/app/plugins/report-assistant" },
    selection: { excluded: ["mcp:sales", "hook:report-path"], mcp: {} },
  });
  const pluginReady = await until(async () => {
    const j = await api(`/plugins/jobs/${encodeURIComponent(pluginJob.id)}`);
    if (j.status === "failed") throw new Error(j.error);
    return j.status === "ready" ? j : null;
  });
  const pluginSaved = await api(
    `/plugins/jobs/${encodeURIComponent(pluginReady.id)}/confirm`,
    "POST",
    { requestId: crypto.randomUUID(), confirmation: pluginReady.confirmation },
  );
  assert(
    (await api("/skills")).entries.some(
      (e) => e.plugin?.pluginId === pluginSaved.pluginId,
    ),
  );
  assert(docker("exec", container, "git", "--version").includes("git version"));
  passed("插件本地安装、兼容排除、Skill 接入和容器 Git 可用");
  compose("restart", "myagent");
  await ready();
  assert.equal(
    (await api(`/memories/entries/${memoryEntry.id}`)).text,
    memoryEntry.text,
  );
  passed("长期记忆 Markdown 正文和 SQLite 索引随重启保留");
  assert.equal(
    (await api("/plugins?scope=user"))[0].version,
    pluginSaved.version,
  );
  assert(
    (await api("/skills")).entries.some(
      (e) => e.plugin?.pluginId === pluginSaved.pluginId,
    ),
  );
  passed("插件安装版本与只读运行副本重启恢复");
  assert.deepEqual(await api(`/sessions/${session.id}`), complete);
  assert.equal((await api("/settings")).hasKey, true);
  assert.deepEqual(
    (await api("/command-policy/config?scope=user")).document,
    commandSaved.document,
  );
  passed("正常容器重启保留完整历史、设置与命令规则");
  assert.deepEqual(
    (await api(`/sessions/${skillSession.id}/context`)).skills,
    skillContext.skills,
  );
  assert((await api("/skills")).entries.some((e) => e.id === skillEntry.id));
  passed("Skill 来源卷与 Run 快照随容器重启保留");
  assert.equal(
    (
      await api(
        `/hooks/config?scope=project&workspaceId=${hookSession.workspaceId}`,
      )
    ).version,
    hookSaved.version,
  );
  assert.deepEqual(await api(`/sessions/${hookSession.id}/hooks`), hookRecords);
  const hookArchive = docker(
    "exec",
    container,
    "node",
    "-e",
    "const f=require('fs');console.log(f.readdirSync('/data/hook-packages').filter(n=>/^[a-f0-9]{64}$/.test(n)).length)",
  ).trim();
  assert(Number(hookArchive) > 0);
  passed("Hook 配置、包快照、事件与来源卷重启持久化");
  // 停服后备份整个已知验收数据卷，恢复到另一个全新卷；不接触用户数据目录。
  compose("stop", "myagent");
  const volume = config.volumes["myagent-data"].name;
  const restoredVolume = `${project}-restored`;
  docker(
    "volume",
    "create",
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    "com.docker.compose.volume=restored",
    restoredVolume,
  );
  ownedVolumes.add(restoredVolume);
  config.volumes.restored = { name: restoredVolume };
  docker(
    "run",
    "--rm",
    "--user",
    "root",
    "--entrypoint",
    "sh",
    "-v",
    `${volume}:/source:ro`,
    "-v",
    `${restoredVolume}:/restore`,
    image,
    "-c",
    "cp -a /source/. /restore/",
  );
  service.volumes = [
    ...service.volumes.filter((v) => v.target !== "/data"),
    { type: "volume", source: "restored", target: "/data" },
  ];
  writeFileSync(file, JSON.stringify(config));
  compose("up", "-d", "--no-build", "--force-recreate", "myagent");
  await ready();
  assert.deepEqual(await api(`/sessions/${session.id}`), complete);
  assert.equal((await api("/settings")).hasKey, true);
  assert.deepEqual(
    (await api("/command-policy/config?scope=user")).document,
    commandSaved.document,
  );
  assert.equal(
    (await api(`/memories/entries/${memoryEntry.id}`)).text,
    memoryEntry.text,
  );
  passed(
    "停止后完整卷备份，恢复到新卷，历史、凭证引用、命令规则及长期记忆一致",
  );
  assert.equal(
    docker(
      "exec",
      container,
      "node",
      "-e",
      "console.log(require('fs').readFileSync(require('path').join(process.argv[1], 'persist.txt'), 'utf8'))",
      taskPath,
    ).trim(),
    "workspace-persisted",
  );
  passed("默认目录按会话隔离，工作区独立卷在重启与数据恢复后保留文件");
  // 显式完全访问不依赖容器能否嵌套沙箱；标准任务仍停在审批，不以隔离失败触发放权。
  for (const apiProtocol of ["chat_completions", "responses"]) {
    saved = await api("/settings", "PUT", {
      apiProtocol,
      baseUrl: "http://provider:8080/v1",
      model: "full-access",
      systemPrompt: "",
      expectedRevision: saved.revision,
    });
    const fullSession = await api("/sessions", "POST", {});
    const full = await api(`/sessions/${fullSession.id}/runs`, "POST", {
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      content: "容器完全访问验收",
      executionMode: "full_access",
    });
    await until(
      async () =>
        (await api(`/sessions/${fullSession.id}`)).latestRun?.status ===
        "succeeded",
    );
    const execution = await api(`/sessions/${fullSession.id}/execution`);
    assert.equal(execution.approvals.length, 0);
    assert.equal(execution.invocations[0].status, "succeeded");
    assert.equal(execution.invocations[0].executionMode, "full_access");
    assert(
      JSON.stringify(execution.invocations[0].result).includes(
        "FULL_ACCESS_CONTAINER",
      ),
    );
    assert.equal(
      docker("exec", container, "cat", "/workspaces/full-access-check.txt"),
      "FULL_ACCESS_CONTAINER",
    );
    compose("restart", "myagent");
    await ready();
    const after = await api(`/sessions/${fullSession.id}`);
    assert.equal(after.latestRun.id, full.run.id);
    assert.equal(after.latestRun.executionMode, "full_access");
    assert.equal(
      docker("exec", container, "cat", "/workspaces/full-access-check.txt"),
      "FULL_ACCESS_CONTAINER",
    );
    const standardSession = await api("/sessions", "POST", {});
    await api(`/sessions/${standardSession.id}/runs`, "POST", {
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      content: "标准权限对照",
      executionMode: "standard",
    });
    await until(
      async () =>
        (await api(`/sessions/${standardSession.id}`)).activeRun?.status ===
        "waiting_approval",
    );
    await api(`/sessions/${standardSession.id}`, "DELETE");
    await api(`/sessions/${fullSession.id}`, "DELETE");
    passed(
      `${apiProtocol} 完全访问真实命令/本机网络、无审批、卷恢复与标准模式对照`,
    );
  }
  for (const apiProtocol of ["chat_completions", "responses"]) {
    saved = await api("/settings", "PUT", {
      apiProtocol,
      baseUrl: "http://provider:8080/v1",
      model: "agent",
      systemPrompt: "",
      expectedRevision: saved.revision,
    });
    const agentSession = await api("/sessions", "POST", {});
    await api(`/sessions/${agentSession.id}/runs`, "POST", {
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      content: "Agent 容器闭环",
    });
    const agentResult = await until(async () => {
      const s = await api(`/sessions/${agentSession.id}`);
      return s.latestRun?.status === "succeeded" ? s : null;
    });
    assert.equal(agentResult.latestRun.status, "succeeded");
    assert.equal(agentResult.steps.length, 2);
    assert(agentResult.steps[0].tools.every((t) => t.status === "succeeded"));
    assert.equal(agentResult.steps[0].tools[1].result.data.timezone, "UTC");
    compose("restart", "myagent");
    await ready();
    assert.deepEqual(await api(`/sessions/${agentSession.id}`), agentResult);
    await api(`/sessions/${agentSession.id}`, "DELETE");
    passed(`${apiProtocol} 容器工具、计划、步骤持久化和重启恢复`);
  }
  for (const apiProtocol of ["chat_completions", "responses"]) {
    saved = await api("/settings", "PUT", {
      apiProtocol,
      baseUrl: "http://provider:8080/v1",
      model: "memory",
      systemPrompt: "",
      expectedRevision: saved.revision,
    });
    const source = await api("/sessions", "POST", {});
    await api(`/sessions/${source.id}/runs`, "POST", {
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      content: "项目日志存放于容器星舟目录。",
    });
    await until(
      async () =>
        (await api(`/sessions/${source.id}`)).latestRun?.status === "succeeded",
    );
    const job = await api("/memories/jobs", "POST", {
      sessionId: source.id,
      requestId: crypto.randomUUID(),
    });
    const completed = await until(async () => {
      const j = (await api("/memories")).jobs.find((j) => j.id === job.id);
      return j && !["queued", "running", "yielded"].includes(j.status)
        ? j
        : null;
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.requests, 2);
    compose("restart", "myagent");
    await ready();
    assert((await api("/memories/entries?query=容器星舟")).entries.length > 0);
    await api(`/sessions/${source.id}`, "DELETE");
    assert.equal(
      (await api("/memories/entries?query=容器星舟")).entries.length,
      0,
    );
    passed(`${apiProtocol} 两阶段记忆发布、重启检索与删除来源撤销`);
  }
  for (const apiProtocol of ["chat_completions", "responses"]) {
    saved = await api("/settings", "PUT", {
      apiProtocol,
      baseUrl: "http://provider:8080/v1",
      model: "context",
      contextWindowTokens: 32768,
      outputReserveTokens: 4096,
      systemPrompt: "",
      expectedRevision: saved.revision,
    });
    const session = await api("/sessions", "POST", {});
    for (const content of ["上下文长任务", "继续处理"]) {
      const snapshot = await api(`/sessions/${session.id}`);
      await api(`/sessions/${session.id}/runs`, "POST", {
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot.session.revision,
        content,
      });
      const done = await until(async () => {
        const s = await api(`/sessions/${session.id}`);
        return ["succeeded", "failed", "waiting_context"].includes(
          s.latestRun?.status,
        )
          ? s
          : null;
      });
      assert.equal(done.latestRun.status, "succeeded");
    }
    const view = await api(`/sessions/${session.id}/context`);
    assert(view.summaries.length > 0);
    compose("restart", "myagent");
    await ready();
    assert.deepEqual(await api(`/sessions/${session.id}/context`), view);
    const page = await api(
      `/sessions/${session.id}/history?sourceId=${encodeURIComponent(view.summaries[0].sourceIds.at(-1))}&includeSuperseded=true`,
    );
    assert(page.entries.length > 0);
    await api(`/sessions/${session.id}`, "DELETE");
    passed(`${apiProtocol} 上下文压缩、来源分页与重启恢复`);
  }
  // v11 成员及消息随数据卷恢复；普通会话列表不能混入内部会话。
  saved = await api("/settings", "PUT", {
    baseUrl: "http://provider:8080/v1",
    apiProtocol: "responses",
    model: "teams",
    systemPrompt: "",
    expectedRevision: saved.revision,
  });
  const teamSession = await api("/sessions", "POST", {});
  await api(`/sessions/${teamSession.id}/runs`, "POST", {
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    content: "容器团队任务",
  });
  await until(async () => {
    const s = await api(`/sessions/${teamSession.id}`);
    return s.latestRun?.status === "succeeded" ? s : null;
  });
  const teamBefore = await api(`/sessions/${teamSession.id}/team`);
  assert.equal(teamBefore.members.length, 1);
  assert.equal(teamBefore.members[0].runStatus, "succeeded");
  assert(
    !(await api("/sessions")).sessions.some(
      (s) => s.id === teamBefore.members[0].internalSessionId,
    ),
  );
  compose("restart", "myagent");
  await ready();
  assert.equal(
    (await api(`/sessions/${teamSession.id}/team`)).members[0].id,
    teamBefore.members[0].id,
  );
  assert(
    (await api(`/sessions/${teamSession.id}/team/messages`)).items.length >= 2,
  );
  await api(`/sessions/${teamSession.id}`, "DELETE");
  passed("团队工具闭环、内部会话隔离及 v11 数据卷重启恢复");
  saved = await api("/settings", "PUT", {
    baseUrl: "http://provider:8080/v1",
    model: "hold",
    systemPrompt: "",
    expectedRevision: saved.revision,
  });
  const current = await api(`/sessions/${session.id}`);
  await api(`/sessions/${session.id}/runs`, "POST", {
    requestId: crypto.randomUUID(),
    expectedRevision: current.session.revision,
    content: "制造可控中断",
  });
  await until(async () => {
    const value = await api(`/sessions/${session.id}`);
    return value.activeRun && value.messages.at(-1).content.length > 0;
  });
  // 仅杀掉此验收项目的容器以模拟来不及提交终态的崩溃；等待锁租约过期后再启动检查恢复。
  compose("kill", "-s", "SIGKILL", "myagent");
  await delay(10500);
  compose("up", "-d", "--no-build", "myagent");
  await ready();
  assert.equal(
    (await api(`/observability/calls/${observedCall.id}`)).captures.find(
      (c) => c.id === observedCapture.id,
    ).sha256,
    captureHash,
  );
  assert.equal(
    (
      await api(
        `/observability/calls/${observedCall.id}/captures/${observedCapture.id}`,
      )
    ).capture.status,
    "complete",
  );
  passed("原始材料哈希、调试设置和调用账本随数据卷重启保留");
  const interrupted = await api(`/sessions/${session.id}`);
  assert.equal(interrupted.latestRun.status, "recoverable");
  assert.equal(interrupted.messages.at(-1).content, "容器持久化测试回答");
  assert.equal(interrupted.activeRun.id, interrupted.latestRun.id);
  assert.equal(interrupted.steps.at(-1).status, "interrupted");
  passed("真实进程 SIGKILL 后恢复 recoverable，保留落盘文字且不自动重试");
  await api(`/sessions/${session.id}`, "DELETE");
  await api(`/sessions/${skillSession.id}`, "DELETE");
  await api(`/sessions/${hookSession.id}`, "DELETE");
  assert.equal((await api("/sessions")).sessions.length, 0);
  assert(!compose("logs", "--no-color", "myagent").includes(fakeKey));
  passed("恢复后删除会话与容器日志凭证边界");
  report.imageId = docker(
    "image",
    "inspect",
    image,
    "--format",
    "{{.Id}}",
  ).trim();
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = error instanceof Error ? error.message : "Docker 验收失败";
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  try {
    compose("down", "--volumes", "--remove-orphans");
    const remaining = docker(
      "volume",
      "ls",
      "--filter",
      `name=^${project}-`,
      "--format",
      "{{.Name}}",
    )
      .trim()
      .split("\n");
    for (const volume of remaining) {
      // 名称前缀只是候选筛选，必须同时属于本脚本创建集合才允许删除。
      if (ownedVolumes.has(volume)) docker("volume", "rm", volume);
    }
    report.cleanup = true;
  } catch {
    console.error("验收资源清理失败，请按报告中的 project 名检查。");
    report.cleanup = false;
    report.ok = false;
    process.exitCode = 1;
  }
  report.project = project;
  mkdirSync(".cache/acceptance", { recursive: true });
  writeFileSync(
    ".cache/acceptance/docker.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (report.cleanup) rmSync(temp, { recursive: true, force: true });
  console.info(JSON.stringify(report));
}
