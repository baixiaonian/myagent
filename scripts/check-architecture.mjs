import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const builtins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
);
const purePackages = new Set(["@myagent/contracts", "@myagent/kernel"]);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const within = (parent, path) => {
  const part = relative(parent, path);
  return part === "" || (!part.startsWith("..") && !part.startsWith("/"));
};

export function sourceImports(source, filename) {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument))
        imports.push(argument.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      imports.push(node.argument.literal.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      imports.push(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return imports;
}

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.[cm]?[jt]sx?$/.test(entry.name) &&
          !/\.(test|spec)\./.test(entry.name)
        ? [path]
        : [];
  });
}

export function checkArchitecture(root) {
  const errors = [];
  const { modules } = readJson(resolve(root, "config/modules.json"));
  const byName = new Map(modules.map((module) => [module.name, module]));
  const graph = new Map();
  if (byName.size !== modules.length) errors.push("Duplicate module name");
  for (const parent of ["apps", "packages"]) {
    for (const entry of readdirSync(resolve(root, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const path = `${parent}/${entry.name}`;
      if (!modules.some((module) => module.path === path)) {
        errors.push(`Unregistered workspace directory: ${path}`);
      }
    }
  }
  for (const module of modules) {
    const dir = resolve(root, module.path);
    const manifest = resolve(dir, "package.json");
    if (!existsSync(manifest)) {
      errors.push(`Missing manifest: ${module.path}`);
      continue;
    }
    const pkg = readJson(manifest);
    if (pkg.name !== module.name)
      errors.push(`Module name mismatch: ${module.path}`);
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    };
    const allDependencies = { ...pkg.devDependencies, ...dependencies };
    const internal = Object.keys(allDependencies).filter((name) =>
      name.startsWith("@myagent/"),
    );
    graph.set(module.name, internal);
    for (const name of internal) {
      if (!byName.has(name))
        errors.push(`${module.name}: unknown dependency ${name}`);
      if (!module.allowedDependencies.includes(name)) {
        errors.push(`${module.name}: forbidden dependency ${name}`);
      }
      if (allDependencies[name] !== "workspace:*") {
        errors.push(`${module.name}: use workspace:* for ${name}`);
      }
    }
    if (purePackages.has(module.name)) {
      for (const name of Object.keys(dependencies)) {
        if (!name.startsWith("@myagent/")) {
          errors.push(`${module.name}: external runtime dependency ${name}`);
        }
      }
    }
    for (const file of sourceFiles(resolve(dir, "src"))) {
      const location = relative(root, file);
      for (const specifier of sourceImports(readFileSync(file, "utf8"), file)) {
        if (specifier.startsWith(".")) {
          if (!within(dir, resolve(dirname(file), specifier))) {
            errors.push(
              `${location}: cross-package relative import ${specifier}`,
            );
          }
          continue;
        }
        if (specifier.startsWith("@myagent/")) {
          if (!byName.has(specifier)) {
            errors.push(
              `${location}: deep or unknown workspace import ${specifier}`,
            );
          } else if (!module.allowedDependencies.includes(specifier)) {
            errors.push(`${location}: forbidden import ${specifier}`);
          } else if (!(specifier in dependencies)) {
            errors.push(
              `${location}: undeclared runtime dependency ${specifier}`,
            );
          }
          continue;
        }
        if (purePackages.has(module.name)) {
          errors.push(
            `${location}: external import in pure package ${specifier}`,
          );
          continue;
        }
        if (builtins.has(specifier.replace(/^node:/, ""))) continue;
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (!(packageName in allDependencies)) {
          errors.push(`${location}: undeclared external import ${specifier}`);
        }
      }
    }
  }
  const done = new Set();
  const active = new Set();
  function visit(name, trail) {
    if (active.has(name)) {
      errors.push(`Dependency cycle: ${[...trail, name].join(" -> ")}`);
      return;
    }
    if (done.has(name)) return;
    active.add(name);
    for (const dependency of graph.get(name) ?? [])
      visit(dependency, [...trail, name]);
    active.delete(name);
    done.add(name);
  }
  for (const name of graph.keys()) visit(name, []);
  return errors;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = checkArchitecture(
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.info("Architecture checks passed.");
  }
}
