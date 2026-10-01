/**
 * 上下文观测投影：按实际选入的组件比较版本，输出新增/变化/移出来源。
 * 只保存名称、身份、指纹和大小；正文仍从独立调试材料读取，不能流入 OTLP。
 */

import type { ModelMessage } from "@myagent/kernel";
import type { ContextManifest } from "@myagent/state";
import { hash } from "./context-support.js";

export type ContextComponent = NonNullable<
  ContextManifest["components"]
>[number];
export function contextComponent(
  id: string,
  kind: string,
  label: string,
  value: unknown,
): ContextComponent {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { id, kind, label, hash: hash(value), characters: text.length };
}
export function contextMessages(
  messages: readonly ModelMessage[],
  group: string,
): ContextComponent[] {
  return messages.map((message, index) =>
    contextComponent(
      `${group}:${message.sourceId ?? index}:${message.role}:${message.callId ?? ""}`,
      message.sourceId?.startsWith("team-message:")
        ? "team"
        : message.sourceId?.startsWith("execution-context:")
          ? "execution"
          : group,
      `${message.role}${message.toolCalls?.length ? ` · ${message.toolCalls.map((call) => call.name).join(", ")}` : ""}`,
      message,
    ),
  );
}
export function contextChanges(
  current: ContextComponent[],
  previous?: ContextComponent[],
) {
  const old = new Map(previous?.map((item) => [item.id, item]));
  const next = new Set(current.map((item) => item.id));
  return {
    baselineKnown: previous !== undefined,
    added: previous ? current.filter((item) => !old.has(item.id)) : [],
    changed: previous
      ? current.filter(
          (item) => old.has(item.id) && old.get(item.id)!.hash !== item.hash,
        )
      : [],
    removed: previous?.filter((item) => !next.has(item.id)) ?? [],
  };
}
