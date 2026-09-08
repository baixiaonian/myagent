import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkArchitecture,
  sourceImports,
} from "../../scripts/check-architecture.mjs";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "myagent-boundary-"));
  roots.push(root);
  function write(path: string, value: unknown) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  mkdirSync(join(root, "apps"));
  const modules = [
    {
      name: "@myagent/contracts",
      path: "packages/contracts",
      allowedDependencies: [] as string[],
    },
    {
      name: "@myagent/kernel",
      path: "packages/kernel",
      allowedDependencies: ["@myagent/contracts"],
    },
  ];
  write("config/modules.json", { modules });
  write("packages/contracts/package.json", {
    name: "@myagent/contracts",
    dependencies: {},
  });
  write("packages/kernel/package.json", {
    name: "@myagent/kernel",
    dependencies: { "@myagent/contracts": "workspace:*" },
  });
  write("packages/contracts/src/index.ts", "export {};");
  write(
    "packages/kernel/src/index.ts",
    'import type {} from "@myagent/contracts";',
  );
  return { root, write, modules };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("workspace boundary guard", () => {
  it("accepts a legal public dependency", () => {
    expect(checkArchitecture(fixture().root)).toEqual([]);
  });
  it.each([
    ['import {} from "@myagent/contracts/src/index.js";', "deep or unknown"],
    [
      'import {} from "../../contracts/src/index.js";',
      "cross-package relative",
    ],
    ['import fs from "node:fs";', "external import in pure package"],
    ['import {} from "@myagent/adapters";', "deep or unknown"],
  ])("rejects forbidden import: %s", (source, reason) => {
    const { root, write } = fixture();
    write("packages/kernel/src/index.ts", source);
    expect(
      checkArchitecture(root).some((error: string) => error.includes(reason)),
    ).toBe(true);
  });
  it("rejects cycles even when both dependency directions are allowed", () => {
    const { root, write, modules } = fixture();
    modules[0]?.allowedDependencies.push("@myagent/kernel");
    write("config/modules.json", { modules });
    write("packages/contracts/package.json", {
      name: "@myagent/contracts",
      dependencies: { "@myagent/kernel": "workspace:*" },
    });
    expect(
      checkArchitecture(root).some((error: string) =>
        error.includes("Dependency cycle"),
      ),
    ).toBe(true);
  });
  it("finds re-exports, type imports, literal dynamic imports and require", () => {
    const imports = sourceImports(
      'export * from "one"; type T = import("two").T; import("three"); require("four"); // import "not-real"',
      "test.ts",
    );
    expect(imports).toEqual(["one", "two", "three", "four"]);
  });
});
