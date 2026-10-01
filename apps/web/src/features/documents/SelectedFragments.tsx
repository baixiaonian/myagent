/** 对话输入区的选段附件：摘要芯片和可移除明细，传输仅在用户发送时组合，不污染输入文字。 */
import { MessageSquareText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
export interface SelectedFragment {
  id: string;
  path: string;
  revision: string;
  text: string;
  unsaved: boolean;
  workspaceId: string;
}
export function fragmentContext(fragments: SelectedFragment[]) {
  return fragments
    .map(
      (f) =>
        `引用文档：${f.path}\n项目：${f.workspaceId}\n读取版本：${f.revision}${f.unsaved ? "（选段来自编辑中的草稿）" : ""}\n选中内容：\n${f.text
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n")}`,
    )
    .join("\n\n");
}
export function SelectedFragments({
  fragments,
  onRemove,
}: {
  fragments: SelectedFragment[];
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  if (!fragments.length) return null;
  return (
    <div ref={root} className="selected-fragments">
      <button
        type="button"
        className="selected-fragments-chip"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MessageSquareText size={15} />
        {fragments.length} 个已选文本片段
      </button>
      {open && (
        <section className="selected-fragments-panel" aria-label="已选文本片段">
          {fragments.map((f) => (
            <section key={f.id}>
              <header>
                <span title={f.path}>{f.path}</span>
                <button
                  type="button"
                  aria-label={`移除片段 ${f.path}`}
                  onClick={() => onRemove(f.id)}
                >
                  <X size={14} />
                </button>
              </header>
              <blockquote>{f.text}</blockquote>
            </section>
          ))}
        </section>
      )}
    </div>
  );
}
