/**
 * Trace 页面只读加载器：独立分页 Span/事件，保留已加载页并以单个串行轮询更新活动节点。
 * 页游标按已完整读取的区间推进；轮询绝不能把未读取的中间页标成已加载。
 */
import type { ChatClient, TracePage } from "@myagent/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

function merge<T extends { id: string }>(old: T[], fresh: T[]) {
  const values = new Map(old.map((v) => [v.id, v]));
  for (const item of fresh) values.set(item.id, item);
  return [...values.values()];
}

export function useTrace(client: ChatClient, traceId: string) {
  const [page, setPage] = useState<TracePage | null>(null),
    [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false),
    [refreshKey, setRefreshKey] = useState(0);
  const generation = useRef(0),
    paging = useRef(false),
    latest = useRef(page);
  latest.current = page;
  useEffect(() => {
    void refreshKey; // 手动刷新只重启只读轮询，不触发任何业务请求。
    const version = ++generation.current;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    setError("");
    const update = async () => {
      try {
        // 已加载的后续页也需更新，否则长任务的活动节点可能永远停留在旧状态。
        const old = latest.current,
          spanCount = old?.trace.id === traceId ? old.spans.length : 0;
        let fresh = await client.trace(traceId);
        let cursor = fresh.nextSpanOffset;
        while (cursor !== null && cursor < spanCount) {
          const more = await client.trace(traceId, cursor, 0);
          if (disposed) return;
          fresh = {
            ...fresh,
            spans: merge(fresh.spans, more.spans),
            nextSpanOffset: more.nextSpanOffset,
          };
          if (more.nextSpanOffset !== null && more.nextSpanOffset <= cursor)
            throw Error("节点分页游标未前进。");
          cursor = more.nextSpanOffset;
        }
        if (disposed || version !== generation.current) return;
        setPage((previous) => {
          if (!previous || previous.trace.id !== traceId) return fresh;
          return {
            ...fresh,
            spans: merge(previous.spans, fresh.spans),
            events: merge(previous.events, fresh.events),
            nextSpanOffset:
              fresh.nextSpanOffset === null
                ? null
                : Math.max(fresh.nextSpanOffset, previous.spans.length),
            nextEventOffset:
              fresh.nextEventOffset === null
                ? null
                : Math.max(fresh.nextEventOffset, previous.events.length),
          };
        });
        setError("");
      } catch (e) {
        if (!disposed)
          setError(e instanceof Error ? e.message : "读取链路失败");
      }
      if (!disposed) timer = setTimeout(() => void update(), 1000);
    };
    void update();
    return () => {
      disposed = true;
      generation.current++;
      clearTimeout(timer);
    };
  }, [client, traceId, refreshKey]);

  const loadMore = useCallback(
    async (kind: "spans" | "events") => {
      const current = latest.current;
      if (paging.current || !current || current.trace.id !== traceId) return;
      const cursor =
        kind === "spans" ? current.nextSpanOffset : current.nextEventOffset;
      if (cursor === null) return;
      const version = generation.current;
      paging.current = true;
      setLoadingMore(true);
      try {
        const more = await client.trace(
          traceId,
          kind === "spans" ? cursor : 0,
          kind === "events" ? cursor : 0,
        );
        if (version !== generation.current) return;
        setPage((old) =>
          !old || old.trace.id !== traceId
            ? old
            : kind === "spans"
              ? {
                  ...old,
                  spans: merge(old.spans, more.spans),
                  nextSpanOffset: more.nextSpanOffset,
                }
              : {
                  ...old,
                  events: merge(old.events, more.events),
                  nextEventOffset: more.nextEventOffset,
                },
        );
        setError("");
      } catch (e) {
        if (version === generation.current)
          setError(e instanceof Error ? e.message : "分页读取失败");
      } finally {
        paging.current = false;
        if (version === generation.current) setLoadingMore(false);
      }
    },
    [client, traceId],
  );
  return {
    page: page?.trace.id === traceId ? page : null,
    error,
    loadingMore,
    loadMore,
    refresh: () => setRefreshKey((key) => key + 1),
  };
}
