/** 输入区技能菜单：选择仅修改当前草稿的结构化 ID，不创建会话；按项目隔离迟到的目录响应。 */
import type { ChatClient, SkillEntry } from "@myagent/sdk";
import { BookOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
export function SkillPicker({
  client,
  workspaceId,
  selected,
  onChange,
  draft,
  onComplete,
}: {
  client: ChatClient;
  workspaceId?: string | undefined;
  selected: string[];
  onChange: (ids: string[]) => void;
  draft: string;
  onComplete: (name: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [entries, setEntries] = useState<SkillEntry[]>([]),
    [query, setQuery] = useState(""),
    [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const mention = /(?:^|\s)\$([a-z0-9-]*)$/.exec(draft)?.[1];
  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次打开菜单都需要刷新目录，反映设置页刚完成的启停。
  useEffect(() => {
    let alive = true;
    void client
      .skills(workspaceId)
      .then((r) => {
        if (alive) {
          setEntries(r.entries.filter((e) => e.enabled && !e.error));
          setError("");
        }
      })
      .catch((e) => {
        if (alive)
          setError(e instanceof Error ? e.message : "技能目录无法读取");
      });
    return () => {
      alive = false;
    };
  }, [client, workspaceId, open]);
  const [dismissed, setDismissed] = useState<string | null>(null),
    [highlight, setHighlight] = useState(0);
  const shown = open || (mention !== undefined && dismissed !== draft);
  useEffect(() => {
    if (!shown) return;
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        setOpen(false);
        setDismissed(draft);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [shown, draft]);
  const matches = entries.filter((e) =>
    `${e.name} ${e.description}`
      .toLowerCase()
      .includes((mention ?? query).toLowerCase()),
  );
  function choose(entry: SkillEntry) {
    onChange([...new Set([...selected, entry.id])]);
    if (mention !== undefined) onComplete(entry.name);
    setOpen(false);
    setDismissed(draft);
    setQuery("");
    setHighlight(0);
  }
  useEffect(() => {
    if (!shown) return;
    const key = (event: KeyboardEvent) => {
      if (
        !(event.target instanceof HTMLTextAreaElement) ||
        event.isComposing ||
        event.keyCode === 229
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(draft);
        setOpen(false);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight(
          (old) =>
            (old +
              (event.key === "ArrowDown" ? 1 : -1) +
              Math.max(1, matches.length)) %
            Math.max(1, matches.length),
        );
      } else if (event.key === "Enter" && !event.shiftKey && matches.length) {
        event.preventDefault();
        event.stopPropagation();
        const entry = matches[highlight % matches.length];
        if (entry) choose(entry);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  return (
    <div className="skill-picker" ref={root}>
      <button
        type="button"
        aria-label="选择本轮技能"
        aria-expanded={shown}
        onClick={() => setOpen((v) => !v)}
      >
        <BookOpen size={13} />
        技能{selected.length ? ` · ${selected.length}` : ""}
      </button>
      {selected.map((id) => (
        <button
          className="skill-chip"
          type="button"
          key={id}
          onClick={() => onChange(selected.filter((v) => v !== id))}
          title="移除本轮选择"
        >
          {entries.find((e) => e.id === id)?.name ?? "所选技能"} ×
        </button>
      ))}
      {shown && (
        <div
          className="skill-menu"
          role="dialog"
          aria-label="选择本轮技能"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              setDismissed(draft);
              root.current?.querySelector("button")?.focus();
              e.stopPropagation();
            }
          }}
        >
          <input
            aria-label="查找本轮技能"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按名称或用途查找"
          />
          {error && <p role="alert">{error}</p>}
          {matches.map((entry, index) => (
            <button
              type="button"
              key={entry.id}
              data-highlight={index === highlight}
              onClick={() => choose(entry)}
            >
              <strong>{entry.name}</strong>
              <small>
                {entry.scope === "project" ? "项目" : "用户"} ·{" "}
                {entry.description}
              </small>
            </button>
          ))}
          {!entries.length && <p>暂无可用技能，可在“技能”设置中添加来源。</p>}
          {entries.length > 0 && !matches.length && (
            <p>没有匹配的技能，试试其他名称。</p>
          )}
          <small>
            只对当前一轮任务生效；未明确选择时，模型仍可按需使用技能。
          </small>
        </div>
      )}
    </div>
  );
}
