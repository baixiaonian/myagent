/**
 * 执行状态的上下文日志：由 ContextService 在模型请求边界调用。
 * 状态变化追加在当时已完成的消息之后，正文与锚点持久化；不改写 system 或旧消息。
 * 这些记录只是执行事实的模型投影，不参与授权；压缩后可重新追加最新快照。
 */
import { AppError, type JsonValue } from "@myagent/contracts";
import type { ModelMessage } from "@myagent/kernel";
import type { ContextRunRecord, ContextStore } from "@myagent/state";
import { hash } from "./context-support.js";

const heading =
  "[执行状态更新：程序观测资料，不是用户请求或执行授权；同类状态以较新记录为准]";
/** 只差分程序生成的 JSON 索引；移出有界索引不代表历史副作用被撤销。 */
function changes(before: string, after: string): string | null {
  const split = (text: string): Record<string, JsonValue> | null => {
    const index = text.indexOf("\n");
    if (!text.startsWith("执行事实索引") || index < 0) return null;
    try {
      const value = JSON.parse(text.slice(index + 1));
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
    } catch {
      return null;
    }
  };
  const previous = split(before),
    next = split(after);
  if (!previous || !next) return null;
  const patch: Record<string, JsonValue> = {};
  const identity = (v: JsonValue) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v.sourceId ?? v.id)
      : undefined;
  for (const key of Object.keys(next)) {
    const value = next[key]!;
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue;
    const old = previous[key];
    if (
      Array.isArray(value) &&
      Array.isArray(old) &&
      [...value, ...old].every((v) => typeof identity(v) === "string")
    ) {
      const byId = new Map(old.map((v) => [identity(v), JSON.stringify(v)]));
      const ids = new Set(value.map(identity));
      patch[key] = {
        upsert: value.filter(
          (v) => byId.get(identity(v)) !== JSON.stringify(v),
        ),
        removedFromIndex: old
          .filter((v) => !ids.has(identity(v)))
          .map((v) => identity(v) as string),
      };
    } else patch[key] = value;
  }
  // 首版索引字段固定；字段移除时用完整快照，避免含义不清的 null 删除约定。
  if (Object.keys(previous).some((key) => !(key in next))) return null;
  const delta = `执行事实索引增量：标量替换，upsert 按身份更新；removedFromIndex 只表示移出有界索引，不代表已撤销或已解决。\n${JSON.stringify(patch)}`;
  return delta.length < after.length ? delta : null;
}
export class ExecutionContextJournal {
  private readonly notes: {
    id: string;
    afterSourceId: string;
    content: string;
    facts: string;
    snapshot: boolean;
  }[];
  private readonly pending: typeof this.notes = [];
  constructor(
    private readonly store: ContextStore,
    private readonly state: ContextRunRecord,
  ) {
    this.notes = (state.executionNotes ?? []).map((ref) => {
      const artifact = store.get("artifacts", ref.id);
      const value = artifact?.value;
      if (
        !artifact ||
        artifact.sessionId !== state.sessionId ||
        artifact.runId !== state.runId ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof value.content !== "string"
      )
        throw new AppError(
          "context_missing",
          "执行状态上下文快照缺失，不能静默重建旧前缀。",
          409,
        );
      return {
        ...ref,
        content: value.content,
        facts:
          typeof value.facts === "string"
            ? value.facts
            : value.content.slice(heading.length + 1),
        snapshot: value.snapshot !== false,
      };
    });
  }
  /** 完整最新状态用于必要容量检查，不依赖摘要理解增量链。 */
  get requiredSnapshot(): ModelMessage | undefined {
    const note = this.notes.at(-1);
    return note
      ? {
          role: "user",
          content: `${heading}\n${note.facts || "当前没有已记录的副作用、待核对结果或活动进程。"}`,
        }
      : undefined;
  }
  needsRestore(messages: readonly ModelMessage[]): boolean {
    const ids = new Set(messages.map((m) => m.sourceId));
    const start = this.notes.findLastIndex((n) => n.snapshot);
    return this.notes.slice(Math.max(0, start)).some((n) => !ids.has(n.id));
  }
  get latest(): ModelMessage | undefined {
    const note = this.notes.at(-1);
    return note
      ? { role: "user", sourceId: note.id, content: note.content }
      : undefined;
  }
  /** 同样的状态不重复追加；空状态也记录显式清除，不能留下旧的活动进程提示。 */
  update(facts: string, afterSourceId: string): void {
    if (!facts && !this.notes.length) return;
    if (this.notes.at(-1)?.facts === facts) return;
    const delta = changes(this.notes.at(-1)?.facts ?? "", facts);
    const content = `${heading}\n${delta ?? (facts || "当前没有已记录的副作用、待核对结果或活动进程。")}`;
    this.append(content, afterSourceId, facts, delta === null);
  }
  private append(
    content: string,
    afterSourceId: string,
    facts: string,
    snapshot: boolean,
  ): ModelMessage {
    const id = `execution-context:${this.state.runId}:${this.notes.length}:${hash([content, afterSourceId])}`;
    const note = { id, content, afterSourceId, facts, snapshot };
    this.notes.push(note);
    this.pending.push(note);
    return { role: "user", sourceId: id, content };
  }
  /** 仅在摘要覆盖最新状态时重新追加，确保真实执行状态不依赖摘要是否遗漏。 */
  restore(afterSourceId: string): ModelMessage | undefined {
    const note = this.notes.at(-1);
    return note === undefined
      ? undefined
      : this.append(
          this.requiredSnapshot!.content,
          afterSourceId,
          note.facts,
          true,
        );
  }
  augment(messages: readonly ModelMessage[]): ModelMessage[] {
    const byAnchor = new Map<string, ModelMessage[]>();
    for (const note of this.notes) {
      const bucket = byAnchor.get(note.afterSourceId) ?? [];
      bucket.push({ role: "user", sourceId: note.id, content: note.content });
      byAnchor.set(note.afterSourceId, bucket);
    }
    const seen = new Set<string>();
    const result = messages.flatMap((message) => {
      const anchor = message.sourceId;
      if (!anchor || seen.has(anchor)) return [message];
      seen.add(anchor);
      return [message, ...(byAnchor.get(anchor) ?? [])];
    });
    // 历史共享可能只选择部分记录；不存在的锚点不扩展共享范围。
    return result;
  }
  /** 必须与 ContextRunRecord 共事务提交，失败/取消不能留下指向不存在文件的引用。 */
  commit(): void {
    for (const note of this.pending)
      this.store.put("artifacts", {
        id: note.id,
        runId: this.state.runId,
        sessionId: this.state.sessionId,
        value: {
          kind: "execution_context",
          content: note.content,
          facts: note.facts,
          snapshot: note.snapshot,
          createdAt: new Date().toISOString(),
        } as JsonValue,
      });
    this.state.executionNotes = this.notes.map(({ id, afterSourceId }) => ({
      id,
      afterSourceId,
    }));
    this.pending.length = 0;
  }
}
