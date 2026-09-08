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
