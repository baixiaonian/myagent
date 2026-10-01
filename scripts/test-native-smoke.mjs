/**
 * 原生执行打包冒烟：不依赖开发测试库，以生产适配器验证文件、命令与真实隔离。
 * 只使用本进程创建的临时目录；可在 Linux 测试容器内验证，但不改变产品 Compose 权限。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { LocalWorkspace, ToolRegistry, NativeExecutionGateway } = await import(
  pathToFileURL(join(process.cwd(), "packages/adapters/dist/index.js"))
);
const root = await realpath(
  await mkdtemp(join(tmpdir(), "myagent-native-smoke-")),
);
const work = join(root, "work");
const outside = join(root, "outside");
const data = join(root, "data");
await mkdir(work);
await mkdir(outside);
await mkdir(data);
await writeFile(join(outside, "secret.txt"), "private-fixture");
const paths = new LocalWorkspace([data, process.cwd()]);
const workspace = await paths.create(work, "原生验证");
const registry = new ToolRegistry(paths);
const gateway = new NativeExecutionGateway({
  dataDir: data,
  runtimeRoot: process.cwd(),
  protectedPaths: [data],
});
const context = {
  sessionId: "smoke",
  runId: "smoke",
  stepId: "smoke",
  invocationId: "",
  workspace,
};
async function call(name, args, timeoutMs = 5000) {
  const ctx = { ...context, invocationId: randomUUID() };
  const prepared = await registry.prepare(name, JSON.stringify(args), ctx);
  return gateway.dispatch(
    {
      attemptId: randomUUID(),
      prepared,
      context: ctx,
      authorizedResources: prepared.resources,
      timeoutMs,
    },
    new AbortController().signal,
  );
}
try {
  const created = await call("write_file", {
    path: "note.txt",
    content: "你好 Linux\n",
    expectedHash: null,
  });
  assert.equal(created.outcome, "succeeded");
  const read = await call("read_file", { path: "note.txt" });
  assert.equal(read.data.text, "你好 Linux\n");
  const edited = await call("edit_file", {
    path: "note.txt",
    oldText: "Linux",
    newText: "原生沙箱",
    expectedHash: read.data.sha256,
  });
  assert.equal(edited.outcome, "succeeded");
  assert.equal(
    await readFile(join(work, "note.txt"), "utf8"),
    "你好 原生沙箱\n",
  );
  const denied = await call("exec_command", {
    command: `cat '${outside}/secret.txt'; printf escape > '${outside}/escape.txt'`,
    yieldTimeMs: 1000,
  });
  assert.equal(denied.outcome, "failed");
  await assert.rejects(readFile(join(outside, "escape.txt")));
  assert(!JSON.stringify(denied).includes("private-fixture"));
  const command = await call(
    "exec_command",
    {
      command: "read value; printf 'got:%s' \"$value\"; sleep 60",
      yieldTimeMs: 0,
    },
    60000,
  );
  const id = command.data.processId;
  await call("write_stdin", { processId: id, input: "测试\n" });
  const output = await call("read_process", { processId: id, waitMs: 100 });
  assert(JSON.stringify(output.data).includes("got:测试"));
  const stopped = await call("stop_process", { processId: id });
  assert.equal(stopped.data.status, "stopped");
  assert((await gateway.closeRun("smoke")).confirmed);
  console.info(
    JSON.stringify({
      ok: true,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      checks: [
        "文件创建/读取/哈希编辑",
        "越界读写被 OS 拒绝",
        "命令输入输出",
        "真实进程停止",
        "Run 资源清理",
      ],
    }),
  );
} finally {
  await gateway.close();
  await rm(root, { recursive: true, force: true });
}
