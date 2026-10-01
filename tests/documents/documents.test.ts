/** 文档 API 验收：临时真实磁盘覆盖项目越界、版本竞争、字节保留、未知结果隔离与严格 HTTP 边界。 */
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import {
  LocalDocumentFiles,
  LocalWorkspace,
} from "../../packages/adapters/src/index.js";
import {
  DocumentService,
  ExecutionCoordinator,
} from "../../packages/application/src/index.js";
import type {
  ProjectDocument,
  Workspace,
} from "../../packages/contracts/src/index.js";

let root: string,
  workspace: Workspace,
  app: Awaited<ReturnType<typeof buildServer>>;
const headers = { host: "localhost", origin: "http://localhost" };
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "myagent-documents-")));
  await mkdir(join(root, "work"));
  app = await buildServer({ dataDir: join(root, "data"), serveWeb: false });
  workspace = await app.projects.prepare(join(root, "work"));
});
afterEach(async () => {
  await app.server.close();
  await rm(root, { recursive: true, force: true });
});
const url = (suffix: string) => `/api/v1/projects/${workspace.id}/${suffix}`;
async function read(path: string) {
  return app.server.inject({
    method: "GET",
    url: url(`document?${new URLSearchParams({ path })}`),
    headers,
  });
}
async function save(file: ProjectDocument, content: string) {
  return app.server.inject({
    method: "PUT",
    url: url("document"),
    headers,
    payload: { path: file.path, expectedRevision: file.revision, content },
  });
}
it("打开/无编辑保存保持 BOM、CRLF 与 HTML 原字节；目录和绝对引用均返回项目相对路径", async () => {
  const original = "\uFEFF# 标题\r\n\r\n正文 & 内容\r\n";
  await writeFile(join(workspace.path, "hello.md"), original);
  const response = await read(join(workspace.path, "hello.md"));
  expect(response.statusCode).toBe(200);
  const file = response.json<ProjectDocument>();
  expect(file.path).toBe("hello.md");
  expect(file.content).toBe(original);
  expect((await save(file, original)).statusCode).toBe(200);
  expect(await readFile(join(workspace.path, "hello.md"), "utf8")).toBe(
    original,
  );
  const list = await app.server.inject({ url: url("files"), headers });
  expect(list.json().entries[0].kind).toBe("document");
  expect(list.json().nextOffset).toBeNull();
});
it("两个基于同版本的保存只有一个提交，外部修改不能被旧草稿覆盖", async () => {
  await writeFile(join(workspace.path, "a.md"), "before");
  const file = (await read("a.md")).json<ProjectDocument>();
  const results = await Promise.all([save(file, "one"), save(file, "two")]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  await writeFile(join(workspace.path, "a.md"), "外部版本");
  expect((await save(file, "old draft")).statusCode).toBe(409);
  expect(await readFile(join(workspace.path, "a.md"), "utf8")).toBe("外部版本");
});
it("拒绝目录越界、符号链接、失效身份、二进制、大文件和未知字段；读取不创建会话", async () => {
  await writeFile(join(root, "outside.md"), "private");
  await symlink(join(root, "outside.md"), join(workspace.path, "link.md"));
  expect((await read("../outside.md")).statusCode).toBe(403);
  expect((await read("link.md")).statusCode).toBe(403);
  await writeFile(join(workspace.path, "binary.md"), Buffer.from([0xff, 0]));
  expect((await read("binary.md")).statusCode).toBe(400);
  await writeFile(join(workspace.path, "huge.md"), "x".repeat(1048577));
  expect((await read("huge.md")).statusCode).toBe(413);
  expect(
    (await app.server.inject({ url: url("files?extra=true"), headers }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await app.server.inject({
        url: url("files"),
        headers: { host: "localhost", origin: "https://attacker.example" },
      })
    ).statusCode,
  ).toBe(403);
  expect(app.store.listSessions()).toHaveLength(0);
  await rename(workspace.path, join(root, "old"));
  await mkdir(workspace.path);
  expect((await read("a.md")).statusCode).toBe(409);
});
it("保存遵守共享资源锁的有界等待和未知结果隔离，不释放他人的租约", async () => {
  await writeFile(join(workspace.path, "a.md"), "before");
  const file = (await read("a.md")).json<ProjectDocument>();
  const coordinator = new ExecutionCoordinator(25);
  const service = new DocumentService(
    app.store.execution,
    new LocalDocumentFiles(new LocalWorkspace([join(root, "data")])),
    coordinator,
    () => [],
  );
  const release = await coordinator.acquire(
    "agent",
    [{ key: `path:${workspace.path}`, mode: "write" }],
    new AbortController().signal,
  );
  await expect(
    service.save(workspace.id, {
      path: file.path,
      expectedRevision: file.revision,
      content: "after",
    }),
  ).rejects.toMatchObject({ code: "resource_busy" });
  expect(await readFile(join(workspace.path, "a.md"), "utf8")).toBe("before");
  release();
  const quarantined = new DocumentService(
    app.store.execution,
    new LocalDocumentFiles(new LocalWorkspace([])),
    coordinator,
    () => [
      {
        id: "unknown",
        workspaceId: workspace.id,
        sourceSessionId: "session",
        toolName: "exec_command",
        source: { kind: "local" },
        resources: [{ kind: "path", target: workspace.path, access: "write" }],
        createdAt: new Date().toISOString(),
      },
    ],
  );
  await expect(
    quarantined.save(workspace.id, {
      path: file.path,
      expectedRevision: file.revision,
      content: "after",
    }),
  ).rejects.toMatchObject({ code: "document_quarantined" });
  expect(
    (
      await service.save(workspace.id, {
        path: file.path,
        expectedRevision: file.revision,
        content: "after",
      })
    ).content,
  ).toBe("after");
});
