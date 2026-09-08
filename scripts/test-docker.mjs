import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const image = process.env.MYAGENT_TEST_IMAGE ?? "myagent:acceptance-v1";
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
  compose("up", "-d", "--no-build");
  await ready();
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
  compose("restart", "myagent");
  await ready();
  assert.deepEqual(await api(`/sessions/${session.id}`), complete);
  assert.equal((await api("/settings")).hasKey, true);
  passed("正常容器重启保留完整历史与设置");
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
  service.volumes = [{ type: "volume", source: "restored", target: "/data" }];
  writeFileSync(file, JSON.stringify(config));
  compose("up", "-d", "--no-build", "--force-recreate", "myagent");
  await ready();
  assert.deepEqual(await api(`/sessions/${session.id}`), complete);
  assert.equal((await api("/settings")).hasKey, true);
  passed("停止后完整卷备份，恢复到新卷，历史与凭证引用一致");
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
  compose("kill", "-s", "SIGKILL", "myagent");
  await delay(10500);
  compose("up", "-d", "--no-build", "myagent");
  await ready();
  const interrupted = await api(`/sessions/${session.id}`);
  assert.equal(interrupted.latestRun.status, "interrupted");
  assert.equal(interrupted.messages.at(-1).content, "容器持久化测试回答");
  assert.equal(interrupted.activeRun, null);
  passed("真实进程 SIGKILL 后恢复 interrupted，保留落盘文字且不自动重试");
  await api(`/sessions/${session.id}`, "DELETE");
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
