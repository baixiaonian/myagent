/** Skill 纯协议与选择逻辑：由应用层编排，文件和 YAML 解析通过适配端口注入，不拥有执行循环。 */
import {
  AppError,
  type SkillEntry,
  type SkillResourcePage,
  type SkillSource,
} from "@myagent/contracts";
export interface SkillPackage {
  version: string;
  body: string;
  runtimePath: string;
  files: { path: string; hash: string; bytes: number; binary: boolean }[];
}
export interface SkillFilesPort {
  readonly runtimeRoot: string;
  scan(source: SkillSource, fresh?: boolean): SkillEntry[];
  validateSource(path: string): string;
  detail(entry: SkillEntry): string;
  resources(entry: SkillEntry): { path: string; bytes: number }[];
  capture(entry: SkillEntry, signal: AbortSignal): Promise<SkillPackage>;
  materialize(pkg: SkillPackage, signal: AbortSignal): Promise<void>;
  read(pkg: SkillPackage, path: string, cursor?: string): SkillResourcePage;
  collect(keep: Set<string>): void;
  close(): void;
}
/** 明确提及只识别独立的 $name；忽略 fenced/inline code 与转义，避免把示例中的名称当作选择。 */
export function explicitSkills(
  text: string,
  entries: SkillEntry[],
  selected: readonly string[] = [],
): string[] {
  const ids = new Set(selected);
  const plain = text
    .replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g, " ")
    .replace(/`[^`]*`/g, " ");
  for (const match of plain.matchAll(
    /(?<![\\\w])\$([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])/g,
  )) {
    const found = entries.filter(
      (e) => e.name === match[1] && e.enabled && !e.error,
    );
    if (!found.length) continue;
    if (found.length > 1 && !found.some((e) => ids.has(e.id)))
      throw new AppError(
        "skill_ambiguous",
        `技能 ${match[1]} 有多个来源，请在技能菜单中明确选择。`,
        409,
      );
    if (found.length === 1) ids.add(found[0]!.id);
  }
  for (const id of ids)
    if (!entries.some((e) => e.id === id && e.enabled && !e.error))
      throw new AppError(
        "skill_unavailable",
        "所选技能不可用，请刷新技能目录。",
        409,
      );
  return [...ids].sort();
}
/** 主说明完整性在文件层验证；这里只校验跨来源共用的标准元信息。 */
export function validateSkillMetadata(
  value: unknown,
  folder: string,
): { name: string; description: string; compatibility?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("invalid_skill", "SKILL.md 缺少 YAML 元信息。");
  const item = value as Record<string, unknown>;
  if (
    typeof item.name !== "string" ||
    item.name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.name) ||
    item.name !== folder
  )
    throw new AppError(
      "invalid_skill",
      "技能 name 必须与目录名一致，使用小写字母、数字和单连字符，最多 64 字符。",
    );
  if (
    typeof item.description !== "string" ||
    !item.description.trim() ||
    item.description.length > 1024
  )
    throw new AppError(
      "invalid_skill",
      "技能 description 必须为 1–1024 字符。",
    );
  if (
    item.compatibility !== undefined &&
    (typeof item.compatibility !== "string" || item.compatibility.length > 500)
  )
    throw new AppError("invalid_skill", "compatibility 最多 500 字符。");
  return {
    name: item.name,
    description: item.description,
    ...(typeof item.compatibility === "string"
      ? { compatibility: item.compatibility }
      : {}),
  };
}
