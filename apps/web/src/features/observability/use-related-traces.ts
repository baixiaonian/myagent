/**
 * 同任务恢复段只读合并：底层 Trace/Span 身份不变，页面按真实墙钟连续排列。
 * 各段独立分页，有限并发读取；旧段失败不抹去当前段。不会重开已结束 Span 或启动运行。
 */
import type { ChatClient, TracePage, TraceRecord } from "@myagent/sdk";
import { useEffect, useRef, useState } from "react";
export function useRelatedTraces(
  client: ChatClient,
  primary: TracePage | null,
  segments: TraceRecord[],
) {
  const [pages, setPages] = useState<Record<string, TracePage>>({});
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const key = segments
    .filter((s) => s.id !== primary?.trace.id)
    .map((s) => s.id)
    .sort()
    .join(",");
  const generation = useRef(0);
  const latest = useRef(pages);
  latest.current = pages;
  const [revision, setRevision] = useState(0);
  const retry = () => setRevision((v) => v + 1);
  useEffect(() => {
    const current = ++generation.current;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    void revision;
    const ids = key ? key.split(",") : [];
    setPages((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([id]) => ids.includes(id)),
      ),
    );
    setLoading(false);
    setError("");
    const read = async () => {
      let active = false;
      for (let i = 0; i < ids.length; i += 2) {
        const results = await Promise.allSettled(
          ids.slice(i, i + 2).map(async (id) => {
            let fresh = await client.trace(id);
            const old = latest.current[id];
            let cursor = fresh.nextSpanOffset;
            while (cursor !== null && cursor < (old?.spans.length ?? 0)) {
              const next = await client.trace(id, cursor, 0);
              if (cancelled) return fresh;
              if (next.nextSpanOffset !== null && next.nextSpanOffset <= cursor)
                throw Error("恢复段分页未前进");
              fresh = {
                ...fresh,
                spans: [
                  ...new Map(
                    [...fresh.spans, ...next.spans].map((span) => [
                      span.id,
                      span,
                    ]),
                  ).values(),
                ],
                nextSpanOffset: next.nextSpanOffset,
              };
              cursor = next.nextSpanOffset;
            }
            return fresh;
          }),
        );
        if (cancelled || generation.current !== current) return;
        for (const result of results) {
          if (result.status === "fulfilled") {
            const fresh = result.value;
            active ||=
              fresh.trace.status === "running" && !fresh.trace.incomplete;
            setPages((old) => {
              const previous = old[fresh.trace.id];
              return {
                ...old,
                [fresh.trace.id]: {
                  ...fresh,
                  events: [
                    ...new Map(
                      [...(previous?.events ?? []), ...fresh.events].map(
                        (event) => [event.id, event],
                      ),
                    ).values(),
                  ],
                  nextEventOffset:
                    fresh.nextEventOffset === null
                      ? null
                      : Math.max(
                          fresh.nextEventOffset,
                          previous?.events.length ?? 0,
                        ),
                },
              };
            });
          } else setError("部分恢复段读取失败，可刷新重试；当前段仍可查看。");
        }
      }
      if (active && !cancelled) timer = setTimeout(() => void read(), 1000);
    };
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      generation.current++;
    };
  }, [client, key, revision]);
  const more = Object.values(pages).filter(
    (page) => page.nextSpanOffset !== null || page.nextEventOffset !== null,
  );
  const loadMore = async () => {
    if (loading) return;
    setLoading(true);
    const current = generation.current;
    try {
      for (const page of more) {
        const next = await client.trace(
          page.trace.id,
          page.nextSpanOffset ?? 0,
          page.nextEventOffset ?? 0,
        );
        if (current !== generation.current) return;
        setPages((old) => ({
          ...old,
          [page.trace.id]: {
            ...next,
            nextSpanOffset:
              page.nextSpanOffset === null ? null : next.nextSpanOffset,
            nextEventOffset:
              page.nextEventOffset === null ? null : next.nextEventOffset,
            spans: [
              ...new Map(
                [...page.spans, ...next.spans].map((s) => [s.id, s]),
              ).values(),
            ],
            events: [
              ...new Map(
                [...page.events, ...next.events].map((e) => [e.id, e]),
              ).values(),
            ],
          },
        }));
      }
      setError("");
    } catch {
      if (current === generation.current)
        setError("恢复段分页读取失败，请重试。");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  };
  const related = Object.values(pages).filter(
    (p) => p.trace.id !== primary?.trace.id,
  );
  if (!primary || related.length === 0)
    return {
      page: primary,
      error,
      loading,
      hasMore: more.length > 0,
      loadMore,
      retry,
    };
  const traces = [primary.trace, ...related.map((p) => p.trace)].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  return {
    page: {
      ...primary,
      trace: {
        ...primary.trace,
        status: primary.trace.task?.status ?? traces.at(-1)!.status,
        startedAt: traces[0]!.startedAt,
        endedAt: traces.some((t) => t.status === "running")
          ? null
          : traces
              .map((t) => t.endedAt ?? t.lastObservedAt ?? t.startedAt)
              .sort()
              .at(-1)!,
        incomplete: traces.some((t) => t.incomplete),
      },
      spans: [...related.flatMap((p) => p.spans), ...primary.spans],
      events: [...related.flatMap((p) => p.events), ...primary.events],
    },
    error,
    loading,
    hasMore: more.length > 0,
    loadMore,
    retry,
  };
}
