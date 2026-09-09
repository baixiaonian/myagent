/**
 * 文档链接检查回归：验证相对文件和锚点，排除外部 URL 及代码块中的示例链接。
 * 使用临时文件夹，不修改真实项目知识库。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { missingLinks } from "../../scripts/check-docs.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("reports missing relative knowledge links without treating URLs or examples as files", () => {
  const root = mkdtempSync(join(tmpdir(), "myagent-docs-"));
  roots.push(root);
  writeFileSync(join(root, "existing.md"), "# Existing");
  // 同一份输入同时含合法锚点、失效路径、URL 和围栏示例；预期只报告真实缺失文件。
  const markdown = [
    "[existing](existing.md#section)",
    "[missing](missing.md)",
    "[web](https://example.com/a)",
    "```md\n[example](example.md)\n```",
  ].join("\n");
  expect(missingLinks(markdown, join(root, "README.md"))).toEqual([
    "missing.md",
  ]);
});
