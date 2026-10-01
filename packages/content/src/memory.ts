/** 长期记忆纯内容逻辑：校验可移植 Markdown 条目、预算选择、脱敏和普通文本匹配；不访问文件或数据库。 */
import {
  AppError,
  type MemoryEntry,
  type MemoryKind,
} from "@myagent/contracts";
export const MEMORY_KINDS: MemoryKind[] = [
  "preference",
  "project",
  "experience",
  "decision",
];
export const memoryTokens = (text: string) =>
  Math.ceil(new TextEncoder().encode(text).length / 3);
/** 不声称能识别所有秘密；已知凭证形态在进入模型、正文及公开返回前统一消除。 */
export function redactMemoryText(text: string): string {
  return text
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{12,})\b/g,
      "[REDACTED_SECRET]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_SECRET]")
    .replace(
      /((?:api[_ -]?key|access[_ -]?token|password|secret|密钥|密码)\s*[=:：]\s*["']?)[^\s"',;，；}]+/gi,
      "$1[REDACTED_SECRET]",
    );
}
export function validateMemoryEntry(
  value: unknown,
): asserts value is MemoryEntry {
  if (!value || typeof value !== "object")
    throw new AppError("memory_format", "记忆条目格式无效。");
  const e = value as MemoryEntry;
  const fields = new Set([
    "id",
    "title",
    "text",
    "kind",
    "project",
    "revision",
    "manual",
    "status",
    "sources",
    "createdAt",
    "updatedAt",
  ]);
  if (Object.keys(e).some((key) => !fields.has(key)))
    throw new AppError("memory_format", "记忆元数据包含未知字段。");
  if (
    typeof e.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(e.id) ||
    typeof e.title !== "string" ||
    !e.title.trim() ||
    e.title.length > 200 ||
    typeof e.text !== "string" ||
    !e.text.trim() ||
    e.text.length > 12000 ||
    /<!-- myagent:/.test(e.text) ||
    !MEMORY_KINDS.includes(e.kind) ||
    !(
      e.project === null ||
      (typeof e.project === "string" && e.project.length <= 1000)
    ) ||
    !Number.isSafeInteger(e.revision) ||
    e.revision < 1 ||
    typeof e.manual !== "boolean" ||
    !["active", "needs_review"].includes(e.status) ||
    !Array.isArray(e.sources) ||
    e.sources.length > 100 ||
    !Number.isFinite(Date.parse(e.createdAt)) ||
    !Number.isFinite(Date.parse(e.updatedAt))
  )
    throw new AppError("memory_format", "记忆条目字段、长度或版本无效。");
  for (const s of e.sources)
    if (
      !s ||
      Object.keys(s).some(
        (key) =>
          ![
            "id",
            "sessionId",
            "recordId",
            "hash",
            "createdAt",
            "status",
          ].includes(key),
      ) ||
      [s.id, s.sessionId, s.recordId, s.hash, s.createdAt, s.status].some(
        (v) => typeof v !== "string" || !v || v.length > 200,
      )
    )
      throw new AppError("memory_format", "记忆来源元数据无效。");
}
/** 全局偏好、当前项目、其他导航按完整条目进入预算；概览是可重建投影，绝不截半句。 */
export function memoryOverviewEntries(
  entries: MemoryEntry[],
  project: string | null,
  budget: number,
): { entry: MemoryEntry; text: string }[] {
  const ordered = entries
    .filter((e) => e.status === "active")
    .toSorted((a, b) => {
      const rank = (e: MemoryEntry) =>
        e.project === null && e.kind === "preference"
          ? 0
          : project && e.project === project
            ? 1
            : e.project === null
              ? 2
              : 3;
      return (
        rank(a) - rank(b) ||
        Number(b.manual) - Number(a.manual) ||
        b.updatedAt.localeCompare(a.updatedAt)
      );
    });
  const selected: { entry: MemoryEntry; text: string }[] = [];
  let remaining = budget;
  for (const entry of ordered) {
    const prefix = `[${entry.id} v${entry.revision}；${entry.project ?? "通用"}；${entry.updatedAt}] ${entry.title}`;
    const text = `${prefix}\n${entry.project && entry.project !== project ? "需要时用 read_memory 查阅。" : entry.text}`;
    const size = memoryTokens(text);
    if (size <= remaining) {
      selected.push({ entry, text });
      remaining -= size;
    } else if (memoryTokens(prefix) <= remaining) {
      selected.push({ entry, text: prefix });
      remaining -= memoryTokens(prefix);
    }
  }
  return selected;
}
