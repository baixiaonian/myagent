/**
 * 独立 Trace 网页：真实父子树与统一标尺的瀑布图，节点详情固定在右侧。
 * URL 保存 Trace/Span 身份；浏览器返回恢复选择。所有数据经 SDK 只读查询，不启动任务或改变采集设置。
 */
import type { ChatClient, TraceRecord } from "@myagent/sdk";
import {
  Activity,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  ExternalLink,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TraceInspector } from "./TraceInspector.js";
import { isViewGroup, presentTrace } from "./trace-presentation.js";
import {
  categories,
  duration,
  isIssue,
  spanCategory,
  spanLabel,
  spanPosition,
  statusText,
  traceDomain,
  traceHref,
  traceRows,
} from "./trace-view.js";
import { useRelatedTraces } from "./use-related-traces.js";
import { useTrace } from "./use-trace.js";
import "./trace.css";

export function TracePageView({
  client,
  traceId,
}: {
  client: ChatClient;
  traceId: string;
}) {
  const {
    page: primaryPage,
    error,
    loadMore,
    loadingMore,
    refresh,
  } = useTrace(client, traceId);
  const [selectedId, setSelectedId] = useState(() =>
    new URLSearchParams(location.search).get("span"),
  );
  const [search, setSearch] = useState(""),
    [issuesOnly, setIssuesOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [diagnostics, setDiagnostics] = useState(false);
  const [wideDetail, setWideDetail] = useState(false);
  const initialized = useRef(new Set<string>());
  const autoCollapse = useRef(true);
  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState("");
  const [segments, setSegments] = useState<TraceRecord[]>([]),
    [segmentCursor, setSegmentCursor] = useState<number | null>(null);
  const [segmentError, setSegmentError] = useState(""),
    [segmentBusy, setSegmentBusy] = useState(false);
  const related = useRelatedTraces(client, primaryPage, segments);
  const page = related.page;
  const rowFocus = useRef<HTMLButtonElement | null>(null);
  const presented = useMemo(
    () =>
      page
        ? presentTrace(page.trace, page.spans, page.events, diagnostics)
        : [],
    [page, diagnostics],
  );
  const rows = useMemo(
    () => traceRows(presented, collapsed, search, issuesOnly),
    [presented, collapsed, search, issuesOnly],
  );
  const selected =
    presented.find((s) => s.id === selectedId) ??
    page?.spans.find((s) => s.id === selectedId);
  useEffect(() => {
    if (!autoCollapse.current) return;
    // React 严格模式会重放更新函数；发现集合在 effect 中维护，状态更新函数保持纯函数。
    const fresh = presented.filter((span) => !initialized.current.has(span.id));
    for (const span of fresh) initialized.current.add(span.id);
    setCollapsed((old) => {
      const next = new Set(old);
      for (const span of fresh) {
        if (
          span.name === "view.unassigned" ||
          (span.name === "agent.step" &&
            span.outcome !== "running" &&
            !isIssue(span.outcome)) ||
          (span.name === "agent.run" &&
            span.scope.agentId &&
            span.scope.agentId !== "main")
        )
          next.add(span.id);
      }
      // 深链接、异常和在途操作的祖先始终可见。用户手动折叠仍可用于浏览长链路。
      for (const span of presented.filter(
        (s) =>
          s.id === selectedId || isIssue(s.outcome) || s.outcome === "running",
      )) {
        let parent = span.parentId;
        const seen = new Set<string>();
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          next.delete(parent);
          parent = presented.find((s) => s.id === parent)?.parentId ?? null;
        }
      }
      return old.size === next.size && [...old].every((id) => next.has(id))
        ? old
        : next;
    });
  }, [presented, selectedId]);
  const rootRunId =
    page?.trace.task?.runId ??
    page?.trace.scope.rootRunId ??
    page?.trace.scope.runId;
  const domain = page ? traceDomain(page.trace, page.spans) : null;
  const filtered = Boolean(search.trim() || issuesOnly);

  useEffect(() => {
    const back = () => {
      setSelectedId(new URLSearchParams(location.search).get("span"));
    };
    window.addEventListener("popstate", back);
    const previous = document.title;
    document.title = `Trace ${traceId.slice(0, 12)} · MyAgent`;
    return () => {
      window.removeEventListener("popstate", back);
      document.title = previous;
    };
  }, [traceId]);
  useEffect(() => {
    if (!rootRunId) return;
    let disposed = false;
    void client
      .traces({ rootRunId, limit: 100 })
      .then((result) => {
        if (!disposed) {
          setSegments(result.items);
          setSegmentCursor(result.nextOffset);
        }
      })
      .catch((e) => {
        if (!disposed)
          setSegmentError(e instanceof Error ? e.message : "读取执行段失败");
      });
    return () => {
      disposed = true;
    };
  }, [client, rootRunId]);
  // 带节点的链接可能指向第二页以后；仅补读到该节点，失败时等待用户明确重试。
  useEffect(() => {
    if (
      selectedId &&
      page &&
      !selected &&
      page.nextSpanOffset !== null &&
      !loadingMore &&
      !error
    )
      void loadMore("spans");
  }, [selectedId, page, selected, loadingMore, error, loadMore]);

  useEffect(() => {
    if (
      selectedId &&
      !selected &&
      primaryPage?.nextSpanOffset === null &&
      related.hasMore &&
      !related.loading &&
      !related.error
    )
      void related.loadMore();
  }, [selectedId, selected, primaryPage?.nextSpanOffset, related]);

  const select = (id: string | null) => {
    history.pushState({}, "", traceHref(traceId, id ?? undefined));
    setSelectedId(id);
    if (id)
      setCollapsed((old) => {
        const next = new Set(old),
          seen = new Set<string>();
        let parent = presented.find((s) => s.id === id)?.parentId;
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          next.delete(parent);
          parent = presented.find((s) => s.id === parent)?.parentId;
        }
        return next;
      });
    setCopied(false);
    setWideDetail(false);
    if (!id) rowFocus.current?.focus();
  };
  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedId) {
        history.pushState({}, "", traceHref(traceId));
        setSelectedId(null);
        setWideDetail(false);
        rowFocus.current?.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedId, traceId]);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError("复制失败，请复制浏览器地址栏中的链接。");
    }
  };

  return (
    <main className="trace-page">
      <header className="trace-topbar">
        <div className="trace-breadcrumb">
          <a href="/" className="trace-brand">
            <Activity size={19} />
            MyAgent
          </a>
          <span>/</span>
          <a href="/?view=observability">执行记录</a>
          <span>/</span>
          <strong>Trace 详情</strong>
        </div>
        <div className="trace-actions">
          <a
            href={
              page?.trace.scope.sessionId
                ? `/?session=${encodeURIComponent(page.trace.scope.sessionId)}`
                : "/"
            }
          >
            <ArrowLeft size={14} />
            返回对话
          </a>
          <button type="button" onClick={() => void copyLink()}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "已复制链接" : "复制链接"}
          </button>
        </div>
      </header>
      <section className="trace-summary" aria-label="链路概览">
        <div className="trace-identity">
          <div className="trace-title-line">
            <h1>执行链路</h1>
            {page && (
              <span
                className={`trace-status ${isIssue(page.trace.status) ? "issue" : page.trace.status === "running" ? "live" : ""}`}
              >
                {statusText(page.trace.status)}
              </span>
            )}
          </div>
          <div className="trace-id">
            <span>Trace ID</span>
            <code>{traceId}</code>
          </div>
        </div>
        {page && (
          <div className="trace-stats">
            <div>
              <span>开始时间</span>
              <strong>{new Date(page.trace.startedAt).toLocaleString()}</strong>
            </div>
            <div>
              <span>{page.trace.endedAt ? "任务观察跨度" : "已观察跨度"}</span>
              <strong>{duration(domain!.range)}</strong>
            </div>
            <div>
              <span>已加载节点</span>
              <strong>
                {page.spans.length}
                {page.nextSpanOffset !== null ? "+" : ""}
              </strong>
            </div>
            <div>
              <span>已加载异常</span>
              <strong
                className={
                  page.spans.some((s) => isIssue(s.outcome))
                    ? "trace-danger"
                    : ""
                }
              >
                {page.spans.filter((s) => isIssue(s.outcome)).length}
              </strong>
            </div>
          </div>
        )}
      </section>
      {copyError && (
        <p className="trace-notice" role="alert">
          {copyError}
        </p>
      )}
      {error && (
        <p className="trace-notice error" role="alert">
          {error}
          <button
            type="button"
            onClick={() => {
              refresh();
              related.retry();
            }}
          >
            重试加载
          </button>
        </p>
      )}
      {page?.trace.task?.error && (
        <p className="trace-notice">
          <CircleAlert size={15} />
          <strong>任务{statusText(page.trace.task.status)}</strong>
          <span>{page.trace.task.error.message}</span>
        </p>
      )}
      {page?.trace.incomplete && (
        <p className="trace-notice">
          此执行段有缺损记录，未知结束时间与耗时保持未知。
        </p>
      )}
      {page && (segments.length > 1 || page.trace.previousTraceId) && (
        <div className="trace-segments">
          {segments.length > 1 && (
            <span>
              同一任务 · 已关联 {segments.length} 个执行段，按 Agent 归组展示
            </span>
          )}
          {page.trace.previousTraceId && (
            <a href={traceHref(page.trace.previousTraceId)}>
              查看前一执行段
              <ExternalLink size={12} />
            </a>
          )}
          {segmentCursor !== null && (
            <button
              type="button"
              disabled={segmentBusy}
              onClick={async () => {
                setSegmentBusy(true);
                try {
                  const result = await client.traces({
                    ...(rootRunId ? { rootRunId } : {}),
                    offset: segmentCursor,
                    limit: 100,
                  });
                  setSegments((old) => [
                    ...new Map(
                      [...old, ...result.items].map((t) => [t.id, t]),
                    ).values(),
                  ]);
                  setSegmentCursor(result.nextOffset);
                  setSegmentError("");
                } catch (e) {
                  setSegmentError(e instanceof Error ? e.message : "读取失败");
                } finally {
                  setSegmentBusy(false);
                }
              }}
            >
              更多执行段
            </button>
          )}
        </div>
      )}
      {related.error && (
        <p className="trace-notice" role="alert">
          {related.error}
        </p>
      )}
      {related.hasMore && (
        <div className="trace-segments">
          <button
            type="button"
            disabled={related.loading}
            onClick={() => void related.loadMore()}
          >
            加载更多恢复段节点与事件
          </button>
        </div>
      )}
      {segmentError && (
        <p className="trace-notice" role="alert">
          {segmentError}
        </p>
      )}
      <div
        className={`trace-workspace ${selectedId ? "has-detail" : ""} ${wideDetail ? "wide-detail" : ""}`}
      >
        <section className="trace-chart" aria-label="执行时间轴">
          <div className="trace-toolbar">
            <label className="trace-search">
              <Search size={15} />
              <input
                type="search"
                aria-label="搜索节点"
                placeholder="搜索节点、工具、模型或 Agent…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="trace-actions">
              <button
                type="button"
                aria-pressed={diagnostics}
                onClick={() => setDiagnostics((v) => !v)}
              >
                内部诊断
              </button>
              <button
                type="button"
                aria-pressed={issuesOnly}
                onClick={() => setIssuesOnly((v) => !v)}
              >
                <CircleAlert size={14} />
                只看异常
              </button>
              <button
                type="button"
                title="展开所有已加载节点"
                onClick={() => {
                  autoCollapse.current = false;
                  setCollapsed(new Set());
                }}
              >
                <ChevronsUpDown size={14} />
                展开
              </button>
              <button
                type="button"
                title="折叠所有分支"
                onClick={() => {
                  autoCollapse.current = false;
                  setCollapsed(new Set(presented.map((s) => s.id)));
                }}
                disabled={filtered}
              >
                <ChevronsDownUp size={14} />
                折叠
              </button>
              <button
                type="button"
                aria-label="刷新链路"
                title="刷新链路"
                onClick={() => {
                  refresh();
                  related.retry();
                }}
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>
          <div className="trace-legend">
            {Object.entries(categories)
              .filter(([key]) => key !== "other")
              .map(([key, label]) => (
                <span key={key}>
                  <i className={`trace-dot ${key}`} />
                  {label}
                </span>
              ))}
            <small>
              {filtered
                ? `匹配 ${rows.filter((r) => r.match).length} 个节点，保留祖先路径`
                : "所有节点共用时间原点 · 耗时含等待与网络"}
            </small>
          </div>
          <div className="trace-table-scroll">
            <table className="trace-tree" aria-label="Span 节点树与瀑布图">
              <colgroup>
                <col className="trace-col-name" />
                <col className="trace-col-status" />
                <col className="trace-col-duration" />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th>节点 / Agent</th>
                  <th>状态</th>
                  <th>耗时</th>
                  <th className="trace-axis-cell">
                    <div className="trace-axis">
                      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                        <span key={f}>
                          {domain ? duration(domain.range * f) : "—"}
                        </span>
                      ))}
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ span: s, depth, hasChildren, match }) => {
                  const position = spanPosition(s, domain!),
                    category = spanCategory(s),
                    expanded = filtered || !collapsed.has(s.id);
                  return (
                    <tr
                      key={s.id}
                      className={`${s.id === selectedId ? "selected" : ""} ${filtered && !match ? "ancestor" : ""}`}
                      data-span-id={s.id}
                    >
                      <td>
                        <div
                          className="trace-node"
                          style={{ paddingLeft: depth * 16 }}
                        >
                          {hasChildren ? (
                            <button
                              type="button"
                              className="trace-fold"
                              aria-label={`${expanded ? "折叠" : "展开"} ${spanLabel(s)}`}
                              aria-expanded={expanded}
                              disabled={filtered}
                              onClick={() => {
                                autoCollapse.current = false;
                                setCollapsed((old) => {
                                  const next = new Set(old);
                                  if (next.has(s.id)) next.delete(s.id);
                                  else next.add(s.id);
                                  return next;
                                });
                              }}
                            >
                              {expanded ? (
                                <ChevronDown size={14} />
                              ) : (
                                <ChevronRight size={14} />
                              )}
                            </button>
                          ) : (
                            <span className="trace-fold-space" />
                          )}
                          <button
                            type="button"
                            className="trace-node-select"
                            aria-pressed={s.id === selectedId}
                            title={`${spanLabel(s)}\n${s.id}`}
                            onClick={(e) => {
                              rowFocus.current = e.currentTarget;
                              select(s.id);
                            }}
                          >
                            <i className={`trace-dot ${category}`} />
                            <span>
                              <strong>{spanLabel(s)}</strong>
                              <small>
                                {s.scope.agentId && s.scope.agentId !== "main"
                                  ? `成员 ${s.scope.agentId.slice(0, 8)}`
                                  : (s.scope.agentName ?? "主任务")}
                              </small>
                            </span>
                          </button>
                        </div>
                      </td>
                      <td>
                        <span
                          className={`trace-state ${isIssue(s.outcome) ? "issue" : s.outcome === "running" ? "live" : ""}`}
                        >
                          {statusText(s.outcome)}
                        </span>
                      </td>
                      <td className="trace-time">
                        {isViewGroup(s) && (
                          <small title="分组区间跨度，不是子节点耗时之和">
                            ≈{" "}
                          </small>
                        )}
                        {s.durationMs === null && s.outcome === "running"
                          ? "进行中"
                          : duration(s.durationMs)}
                      </td>
                      <td className="trace-track-cell">
                        <button
                          type="button"
                          className="trace-track"
                          aria-label={`查看耗时：${spanLabel(s)}`}
                          onClick={(e) => {
                            rowFocus.current = e.currentTarget;
                            select(s.id);
                          }}
                          title={`${spanLabel(s)} · ${duration(s.durationMs)} · +${duration(Date.parse(s.startedAt) - domain!.start)}`}
                        >
                          {s.name === "agent.step" &&
                            presented
                              .filter(
                                (part) =>
                                  part.parentId === s.id &&
                                  [
                                    "context.prepare",
                                    "gen_ai.request",
                                    "view.tools",
                                  ].includes(part.name),
                              )
                              .map((part) => {
                                const phase = spanPosition(part, domain!);
                                return (
                                  <span
                                    key={part.id}
                                    className={`trace-bar trace-phase ${spanCategory(part.name === "view.tools" ? { ...part, name: "tool.execute" } : part)}`}
                                    style={{
                                      left: `${phase.left}%`,
                                      width: `${phase.width}%`,
                                    }}
                                  />
                                );
                              })}
                          <span
                            className={`trace-bar ${s.name === "agent.step" ? "step-outline" : ""} ${category} ${isIssue(s.outcome) ? "issue" : ""} ${s.durationMs === null ? "uncertain" : ""}`}
                            style={{
                              left: `${position.left}%`,
                              width: `${position.width}%`,
                            }}
                          />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!page && (
              <div className="trace-empty">
                <Activity size={28} />
                <strong>
                  {error ? "无法读取此 Trace" : "正在读取执行链路…"}
                </strong>
                <span>
                  {error
                    ? "记录可能已清理，或服务暂时不可用。"
                    : "读取节点与事件，不影响正在执行的任务。"}
                </span>
              </div>
            )}
            {page && !rows.length && (
              <div className="trace-empty">
                <Search size={26} />
                <strong>
                  {filtered ? "当前已加载节点没有匹配项" : "此执行段暂无节点"}
                </strong>
                {filtered && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setIssuesOnly(false);
                    }}
                  >
                    清除筛选
                  </button>
                )}
              </div>
            )}
            {page?.nextSpanOffset !== null && page && (
              <div className="trace-more">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadMore("spans")}
                >
                  {loadingMore ? "正在加载…" : "加载更多节点"}
                </button>
                <span>搜索与筛选仅针对已加载节点</span>
              </div>
            )}
          </div>
          <footer className="trace-chart-footer">
            <span>
              {rows.length} 个展示条目（含分组）
              {page ? ` · ${page.spans.length} 个原始节点已加载` : ""}
            </span>
            <span>
              {page?.trace.status === "running"
                ? "每秒更新"
                : "点击节点查看详情"}
            </span>
          </footer>
        </section>
        {selectedId && (
          <aside className="trace-inspector" aria-label="节点详情">
            <div className="trace-inspector-header">
              <div>
                <small>节点详情</small>
                <h2>{selected ? spanLabel(selected) : "定位节点"}</h2>
              </div>
              <div className="trace-actions">
                <button
                  type="button"
                  aria-label={wideDetail ? "收起详情宽度" : "展开详情宽度"}
                  onClick={() => setWideDetail((v) => !v)}
                >
                  {wideDetail ? (
                    <Minimize2 size={15} />
                  ) : (
                    <Maximize2 size={15} />
                  )}
                </button>
                <button
                  type="button"
                  aria-label="关闭节点详情"
                  onClick={() => select(null)}
                >
                  <X size={17} />
                </button>
              </div>
            </div>
            <div className="trace-inspector-id">
              <code>{selectedId}</code>
              <button
                type="button"
                title="复制节点链接"
                aria-label="复制节点链接"
                onClick={() => void copyLink()}
              >
                <Copy size={13} />
              </button>
            </div>
            {selected ? (
              <>
                <TraceInspector
                  key={selected.id}
                  client={client}
                  traceId={selected.traceId}
                  selected={selected}
                  spans={page!.spans}
                  events={page!.events}
                  origin={domain!.start}
                  select={select}
                  moreEvents={page!.nextEventOffset !== null}
                  loadingMore={loadingMore}
                  loadEvents={() => void loadMore("events")}
                />
              </>
            ) : (
              <div className="trace-empty">
                <span>
                  {page?.nextSpanOffset !== null
                    ? "正在加载节点所在页…"
                    : "节点不存在或已被清理。"}
                </span>
              </div>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}
