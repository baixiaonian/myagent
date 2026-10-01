/** 节点详情的通用分区与复制交互：同页阅读、逐段复制，内容按原值渲染，不把 JSON 当 HTML。 */
import { Check, Copy } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

export function CopyValue({
  value,
  label = "复制",
}: {
  value: string | (() => Promise<string>);
  label?: string;
}) {
  const [status, setStatus] = useState(""),
    busy = useRef(false);
  return (
    <span className="trace-copy-control">
      <button
        type="button"
        aria-label={label}
        disabled={status === "读取中…"}
        onClick={async () => {
          if (busy.current) return;
          busy.current = true;
          setStatus("读取中…");
          try {
            await navigator.clipboard.writeText(
              typeof value === "string" ? value : await value(),
            );
            setStatus("已复制");
          } catch {
            setStatus("复制失败");
          } finally {
            busy.current = false;
          }
        }}
      >
        {status === "已复制" ? <Check size={14} /> : <Copy size={14} />}{" "}
        {status || label}
      </button>
      {status === "复制失败" && (
        <small role="alert">请使用下载或选择正文复制。</small>
      )}
    </span>
  );
}
export function DetailSection({
  title,
  value,
  children,
}: {
  title: string;
  value?: unknown;
  children: ReactNode;
}) {
  return (
    <section className="trace-detail-section" aria-label={title}>
      <header>
        <h3>{title}</h3>
        {value !== undefined && (
          <CopyValue
            label={`复制${title}`}
            value={
              typeof value === "string" ? value : JSON.stringify(value, null, 2)
            }
          />
        )}
      </header>
      {children}
    </section>
  );
}
export function DisplayValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null)
        return <pre>{JSON.stringify(parsed, null, 2)}</pre>;
    } catch {
      /* 普通字符串无需 JSON 化。 */
    }
    return <span>{value || "—"}</span>;
  }
  return typeof value === "object" && value !== null ? (
    <pre>{JSON.stringify(value, null, 2)}</pre>
  ) : (
    <span>{String(value ?? "—")}</span>
  );
}
export function AttributeTable({
  values,
}: {
  values: Record<string, unknown>;
}) {
  return Object.keys(values).length ? (
    <dl className="trace-attribute-table">
      {Object.entries(values).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            <DisplayValue value={value} />
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="trace-section-empty">暂无记录</p>
  );
}
