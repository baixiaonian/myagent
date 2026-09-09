/**
 * 架构检查器回归：在临时微型工作区验证合法导入、深路径、纯内核边界和依赖环。
 * 测试对象是检查规则，不为占位包制造业务能力；清理仅删除本用例创建的目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkArchitecture,
  sourceImports,
} from "../../scripts/check-architecture.mjs";

const roots: string[] = [];
// 只构造足以表达依赖关系的最小工作区；占位源码用于检查器输入，不代表新增业务实现。
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
    // 刻意让两条方向都合法，再检查有向环，避免“允许导入”被错误等同于“允许循环”。
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
