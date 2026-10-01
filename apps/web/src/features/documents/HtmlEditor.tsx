/** HTML 展示入口：交互预览只运行隔离页面；文字编辑使用禁用原脚本的静态选区桥，两者不共享写回能力。 */
import { useEffect, useMemo, useRef } from "react";
import { htmlInteractivePreview } from "./html-interactive-preview.js";
import { htmlPreview, htmlSourceOffset } from "./html-preview.js";
import type { DocumentSelection } from "./selection.js";
export function HtmlEditor({
  content,
  mode,
  onSelection,
}: {
  content: string;
  mode: "preview" | "edit";
  onSelection: (s: DocumentSelection | null) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次正文变化都换令牌，拒绝旧 iframe 的迟到选区。
  const token = useMemo(() => crypto.randomUUID(), [content]);
  const src = useMemo(
    () =>
      mode === "preview"
        ? htmlInteractivePreview(content)
        : htmlPreview(content, token),
    [content, token, mode],
  );
  useEffect(() => {
    if (mode !== "edit") return;
    const listener = (event: MessageEvent) => {
      const value = event.data;
      if (
        event.source === frame.current?.contentWindow &&
        value?.token === token &&
        value.kind === "document-selection-clear"
      ) {
        onSelection(null);
        return;
      }
      if (
        event.source !== frame.current?.contentWindow ||
        !value ||
        value.kind !== "document-selection" ||
        value.token !== token ||
        typeof value.text !== "string" ||
        value.text.length > 6000
      )
        return;
      const parentRect = frame.current?.getBoundingClientRect();
      const rect =
        parentRect &&
        value.rect &&
        [value.rect.left, value.rect.top, value.rect.bottom].every(
          Number.isFinite,
        )
          ? {
              left: parentRect.left + value.rect.left,
              top: parentRect.top + value.rect.top,
              bottom: parentRect.top + value.rect.bottom,
            }
          : undefined;
      const location = rect ? { rect } : {};
      const valid =
        [value.start, value.end, value.from, value.to].every(
          Number.isSafeInteger,
        ) &&
        value.start >= 0 &&
        value.end <= content.length &&
        value.end > value.start &&
        value.from >= 0 &&
        value.to >= value.from;
      if (!valid) {
        onSelection({ text: value.text, from: -1, to: -1, ...location });
        return;
      }
      const raw = content.slice(value.start, value.end);
      const from = value.start + htmlSourceOffset(raw, value.from),
        to = value.start + htmlSourceOffset(raw, value.to);
      // 解码后的源片段必须与可见选区一致；非常规实体或不完整 UTF-16 边界只允许引用，不能错位替换。
      const check = document.createElement("textarea");
      check.innerHTML = content.slice(from, to).replace(/</g, "&lt;");
      onSelection(
        check.value === value.text
          ? { text: value.text, from, to, ...location }
          : { text: value.text, from: -1, to: -1, ...location },
      );
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [content, token, onSelection, mode]);
  return (
    <iframe
      key={mode}
      ref={frame}
      className="document-html-frame"
      title="HTML 文档预览"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={src}
    />
  );
}
