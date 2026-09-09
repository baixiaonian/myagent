/**
 * 项目知识检查器：验证必需文档、模块知识地图、相对链接及迭代索引。
 * 跳过依赖、产物和上游快照；只能发现结构缺失，文档与代码的语义一致性仍需人工审查。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 先移除围栏代码块，再检查相对链接并去掉锚点；示例、外部 URL 不应被当作本地文件。
export function missingLinks(markdown, file) {
  const missing = [];
  const prose = markdown.replace(/```[\s\S]*?```/g, "");
  for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "").split("#")[0];
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    if (!existsSync(resolve(dirname(file), decodeURIComponent(target)))) {
      missing.push(target);
    }
  }
  return missing;
}

export function checkDocs(root) {
  const errors = [];
  // 这里列出新上下文必须具备的知识入口；新增结构性规范时需同步这份清单或现有知识链接。
  const required = [
    "README.md",
    "AGENTS.md",
    "docs/AGENTS.md",
    "docs/README.md",
    "docs/STATUS.md",
    "docs/product/goals.md",
    "docs/architecture/overview.md",
    "docs/architecture/modules.md",
    "docs/architecture/technology.md",
    "docs/architecture/references.md",
    "docs/adr/README.md",
    "docs/protocols/README.md",
    "docs/development/setup.md",
    "docs/development/workflow.md",
    "docs/development/testing.md",
    "docs/history/README.md",
    "docs/roadmap.md",
    "packages/AGENTS.md",
    "packages/kernel/AGENTS.md",
    "packages/adapters/AGENTS.md",
    "packages/state/AGENTS.md",
    "packages/content/AGENTS.md",
    "packages/extensions/AGENTS.md",
    "packages/orchestration/AGENTS.md",
    "apps/AGENTS.md",
    "plugins/AGENTS.md",
    "research/AGENTS.md",
    "scripts/AGENTS.md",
  ];
  for (const file of required) {
    if (!existsSync(resolve(root, file)))
      errors.push(`Missing knowledge file: ${file}`);
  }
  const modules = JSON.parse(
    readFileSync(resolve(root, "config/modules.json"), "utf8"),
  ).modules;
  const modulePage = resolve(root, "docs/architecture/modules.md");
  const moduleText = existsSync(modulePage)
    ? readFileSync(modulePage, "utf8")
    : "";
  for (const module of modules) {
    if (!existsSync(resolve(root, module.path, "README.md"))) {
      errors.push(`Missing module README: ${module.path}`);
    }
    if (!moduleText.includes(`\`${module.path}\``)) {
      errors.push(`Module missing from knowledge map: ${module.path}`);
    }
  }
  // 只遍历项目知识，不进入研究快照、依赖和缓存，以免第三方文档干扰产品检查。
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        [
          "node_modules",
          ".git",
          ".cache",
          "dist",
          "upstream",
          "coverage",
        ].includes(entry.name)
      )
        continue;
      const file = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".md")) {
        for (const target of missingLinks(readFileSync(file, "utf8"), file)) {
          errors.push(`${file}: missing link ${target}`);
        }
      }
    }
  }
  walk(root);
  const history = resolve(root, "docs/history");
  // 每篇带日期的历史必须被索引引用，避免新上下文无法发现已完成迭代。
  if (existsSync(history) && existsSync(resolve(history, "README.md"))) {
    const index = readFileSync(resolve(history, "README.md"), "utf8");
    for (const file of readdirSync(history)) {
      if (
        /^\d{4}-\d{2}-\d{2}.*\.md$/.test(file) &&
        !index.includes(`(${file})`)
      ) {
        errors.push(`Iteration missing from history index: ${file}`);
      }
    }
  }
  return errors;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = checkDocs(
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.info("Documentation checks passed.");
  }
}
