/** Git 获取验证：仅 fetch 网络边界替换成本地仓库，真实读取 Git 对象；不执行 checkout/filter/Hook。 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { LocalPluginFiles } from "../../packages/adapters/src/index.js";

it("固定提交与包子目录，分支变化不改变候选内容", async () => {
  const root = mkdtempSync(join(tmpdir(), "myagent-plugin-git-")),
    repo = join(root, "repo");
  mkdirSync(join(repo, "packages/demo/skills/test"), { recursive: true });
  const git = (args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }).trim();
  git(["init", "-q"]);
  writeFileSync(
    join(repo, "packages/demo/plugin.json"),
    JSON.stringify({ name: "git-example", version: "1" }),
  );
  writeFileSync(
    join(repo, "packages/demo/skills/test/SKILL.md"),
    "---\nname: test\ndescription: 测试\n---\n测试。",
  );
  writeFileSync(join(repo, ".gitattributes"), "*.json filter=unexpected\n");
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const commit = git(["rev-parse", "HEAD"]);
  const files = new LocalPluginFiles(join(root, "data"));
  const port = files as unknown as {
    git(
      cwd: string,
      args: string[],
      signal: AbortSignal,
      max?: number,
    ): Promise<Buffer>;
  };
  const original = port.git.bind(files);
  const mock = vi
    .spyOn(port, "git")
    .mockImplementation(async (cwd, args, signal, max) => {
      if (args[0] === "fetch") {
        execFileSync(
          "/usr/bin/git",
          [
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--depth=1",
            repo,
            commit,
          ],
          {
            cwd,
            stdio: "ignore",
            env: {
              PATH: "/usr/bin:/bin",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          },
        );
        return Buffer.alloc(0);
      }
      return original(cwd, args, signal, max);
    });
  try {
    const candidate = await files.prepare(
      {
        kind: "git",
        url: "https://example.org/demo.git",
        ref: commit,
        subdirectory: "packages/demo",
      },
      new AbortController().signal,
    );
    expect(candidate.commit).toBe(commit);
    expect(candidate.manifest.name).toBe("git-example");
    expect(
      candidate.package.files.every((f) => !f.path.startsWith("packages/")),
    ).toBe(true);
    writeFileSync(
      join(repo, "packages/demo/plugin.json"),
      '{"name":"changed"}',
    );
    expect(candidate.manifest.name).toBe("git-example");
    expect(existsSync(join(repo, "executed"))).toBe(false);
    await expect(
      files.prepare(
        { kind: "git", url: "file:///tmp/repo" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_plugin_source" });
    await expect(
      files.prepare(
        {
          kind: "git",
          url: "https://example.org/repo",
          ref: "--upload-pack=evil",
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_plugin_source" });
  } finally {
    mock.mockRestore();
    files.collect(new Set());
    rmSync(root, { recursive: true, force: true });
  }
});
