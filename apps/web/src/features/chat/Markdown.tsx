/**
 * 安全消息展示：将模型文字渲染为 Markdown、表格和高亮代码，并提供复制反馈。
 * 原始 HTML 跳过、图片仅显示替代文字；代码复制读取实际文本，不复制高亮标记。
 */
import { Check, Copy } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
// 复制行为由点击触发；状态提示会自动恢复，剪贴板不可用时向用户明确反馈失败。
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
// 从 pre.textContent 读取纯文本，避免复制高亮 HTML 或工具栏标题。
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
// 不启用原始 HTML 解析；图片替换成文字以避免隐式外部请求。
// 链接保留渲染器默认 URL 过滤，并使用 noopener / noreferrer 打开新页面。
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
