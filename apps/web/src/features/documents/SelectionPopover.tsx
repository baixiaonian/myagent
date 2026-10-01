/** 选区就地操作条：定位在选区末行附近，随滚动/窗口变化收起，仅提供添加到对话，不提交编辑或模型请求。 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DocumentSelection } from "./selection.js";
export function SelectionPopover({
  selection,
  onQuote,
  onDismiss,
}: {
  selection: DocumentSelection;
  onQuote: () => void;
  onDismiss: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const rect = selection.rect;
    if (!rect) return;
    const width = box.current?.offsetWidth ?? 210,
      height = box.current?.offsetHeight ?? 40;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top:
        rect.bottom + height + 10 < window.innerHeight
          ? rect.bottom + 7
          : Math.max(8, rect.top - height - 7),
    });
  }, [selection]);
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (
        box.current?.contains(event.target as Node) ||
        (event.target instanceof Element &&
          event.target.closest("[data-preserve-document-selection]"))
      )
        return;
      onDismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", onDismiss);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", onDismiss);
      document.removeEventListener("keydown", key);
    };
  }, [onDismiss]);
  if (!selection.rect) return null;
  return (
    <div
      ref={box}
      className="selection-popover"
      role="dialog"
      aria-label="选中文本操作"
      style={position}
    >
      <div className="selection-popover-actions">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onQuote}
        >
          添加到对话
        </button>
      </div>
    </div>
  );
}
