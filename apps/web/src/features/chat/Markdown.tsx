import { Check, Copy } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
export function CopyButton({
  text,
  label = "复制",
}: {
  text: () => string;
  label?: string;
}) {
  const [state, setState] = useState("idle");
  return (
    <button
      className="copy-button"
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text());
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1800);
      }}
    >
      {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
      <span>
        {state === "copied"
          ? "已复制"
          : state === "failed"
            ? "复制失败"
            : label}
      </span>
    </button>
  );
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="code-frame">
      <div className="code-toolbar">
        <span>CODE</span>
        <CopyButton
          label="复制代码"
          text={() => pre.current?.textContent ?? ""}
        />
      </div>
      <pre ref={pre}>{children}</pre>
    </div>
  );
}
export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={{
          pre: CodeBlock,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="muted">[图片：{alt || "未显示"}]</span>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
