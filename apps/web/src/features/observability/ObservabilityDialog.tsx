/** 本地观测工作台：元数据时间轴、用量、价格和显式原始材料读取；不自动拉取大正文。 */
import type {
  ChatClient,
  ModelCallRecord,
  ModelPrice,
  RunObservationSummary,
  TraceRecord,
  UsageSummary,
} from "@myagent/sdk";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelCallDetails } from "./ModelCallDetails.js";
import { traceHref } from "./trace-view.js";
import "./trace.css";
import { Modal } from "../../components/Modal.js";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "读取失败";
const duration = (ms: number | null) =>
  ms === null
    ? "未知 / 未结束"
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(2)} s`;
const mergeRows = <T extends { id: string; startedAt: string }>(
  old: T[],
  fresh: T[],
) => {
  const map = new Map(old.map((row) => [row.id, row]));
  for (const row of fresh) map.set(row.id, row);
  return [...map.values()].sort(
    (a, b) =>
      b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
  );
};
export function costText(usage: UsageSummary) {
  return (
    Object.entries(usage.costs)
      .map(
        ([currency, value]) =>
          `${currency} ${value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`,
      )
      .join(" / ") || "费用未知"
  );
}
/** 使用服务商实际缓存 token 加权；缺失字段保持未知，不从请求前缀推测命中率。 */
function cacheText(usage: UsageSummary) {
  const cache = usage.cache;
  if (!cache || !cache.inputTokens) return "缓存命中未知";
  return `缓存命中 ${((cache.readTokens / cache.inputTokens) * 100).toFixed(1)}%${cache.unknownRequests ? `（${cache.unknownRequests} 次未知）` : ""}`;
}
const title = (name: string) =>
  ({
    "agent.run": "Agent 运行",
    "agent.step": "模型步骤",
    "process.lifecycle": "进程运行",
    "mcp.call": "MCP 调用",
    "mcp.handshake": "MCP 连接",
    "mcp.discovery": "MCP 工具发现",
    "gen_ai.request": "模型请求",
    "model.queue": "模型排队",
    "context.prepare": "准备上下文",
    "context.compact": "压缩上下文",
    "tool.execute": "工具调用",
    "tool.dispatch": "实际派发",
    "tool.lock_wait": "资源锁等待",
    "tool.slot_wait": "执行槽等待",
    "approval.wait": "审批记录",
    "run.waiting_approval": "等待用户审批",
    "run.waiting_agents": "等待成员",
  })[name] ?? name;
const statusText = (status: string) =>
  ({
    running: "运行中",
    succeeded: "已完成",
    cancelled: "已停止",
    failed: "失败",
    interrupted: "已中断",
    waiting_approval: "等待审批",
    waiting_agents: "等待成员",
    waiting_context: "等待上下文处理",
    recoverable: "待恢复",
  })[status] ?? status;
const taskKey = (trace: TraceRecord) =>
  trace.task?.runId ??
  trace.scope.rootRunId ??
  trace.scope.runId ??
  trace.scope.jobId ??
  trace.id;
export function RunObservation({
  client,
  runId,
  active,
  refreshKey,
  onOpen,
}: {
  client: ChatClient;
  runId: string;
  active: boolean;
  refreshKey: number;
  onOpen: () => void;
}) {
  const [value, setValue] = useState<RunObservationSummary | null>(null);
  useEffect(() => {
    // 设置页关闭后重查已完成 Run 的入口状态，不改变聊天或草稿。
    void refreshKey;
    let disposed = false;
    const update = async () => {
      try {
        const summary = await client.runObservation(runId);
        if (!disposed) setValue(summary);
      } catch {
        /* 观测不可用不遮挡聊天。 */
      }
    };
    void update();
    const timer = active ? setInterval(() => void update(), 1000) : undefined;
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, runId, active, refreshKey]);
  if (!value?.usage.requests) return null;
  return (
    <div className="run-observation">
      <span>
        {duration(value.wallMs)} ·{" "}
        {value.usage.inputTokens + value.usage.outputTokens} token
        {value.usage.unknownUsage > 0 ? "（部分未知）" : ""} ·{" "}
        {costText(value.usage)}
        {` · ${cacheText(value.usage)}`}
        {value.usage.unpricedRequests > 0
          ? ` · ${value.usage.unpricedRequests} 次未计价`
          : ""}
      </span>
      {value.debug &&
        (value.traces[0] ? (
          <>
            <a
              href={traceHref(value.traces[0])}
              target="_blank"
              rel="noreferrer"
            >
              执行追踪
            </a>
            {value.traces.length > 1 && (
              <button type="button" onClick={onOpen}>
                全部执行段
              </button>
            )}
          </>
        ) : (
          <button type="button" onClick={onOpen}>
            执行追踪
          </button>
        ))}
    </div>
  );
}
export function ObservabilityDialog({
  client,
  runId,
  onClose,
}: {
  client: ChatClient;
  runId?: string;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<Awaited<
      ReturnType<ChatClient["observationSettings"]>
    > | null>(null),
    [traces, setTraces] = useState<TraceRecord[]>([]);
  const [callId, setCallId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Awaited<
      ReturnType<ChatClient["observationUsage"]>
    > | null>(null),
    [prices, setPrices] = useState<ModelPrice[]>([]);
  const [calls, setCalls] = useState<ModelCallRecord[]>([]),
    [callNext, setCallNext] = useState<number | null>(null);
  const [error, setError] = useState(""),
    [filter, setFilter] = useState({
      sessionId: "",
      model: "",
      status: "",
      purpose: "",
      from: "",
      to: "",
    }),
    [next, setNext] = useState<number | null>(null);
  const [tab, setTab] = useState("traces");
  const [form, setForm] = useState({
      connection: "",
      model: "",
      currency: "USD" as "USD" | "CNY",
      input: "",
      output: "",
      cacheRead: "",
      cacheWrite: "",
    }),
    [priceRevision, setPriceRevision] = useState(0);
  const [sessions, setSessions] = useState<{ id: string; title: string }[]>([]);
  const [runSummary, setRunSummary] = useState<RunObservationSummary | null>(
    null,
  );
  const refreshVersion = useRef(0);
  const saving = useRef(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const alive = useRef(true);
  // 列表轮询只合并第一页，不丢掉用户展开的后续页；游标按已展示的去重记录推进。
  const loaded = useRef({
    traces: [] as TraceRecord[],
    calls: [] as ModelCallRecord[],
    traceNext: undefined as number | null | undefined,
    callNext: undefined as number | null | undefined,
  });
  const query = {
    ...filter,
    ...(runId ? { runId } : {}),
    ...(filter.from ? { from: `${filter.from}T00:00:00.000Z` } : {}),
    ...(filter.to ? { to: `${filter.to}T23:59:59.999Z` } : {}),
  };
  const queryKey = JSON.stringify(query);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const [s, t, u, p, c, summary] = await Promise.all([
        client.observationSettings(),
        client.traces(JSON.parse(queryKey)),
        client.observationUsage(JSON.parse(queryKey)),
        client.modelPrices(),
        client.modelCalls(JSON.parse(queryKey)),
        runId ? client.runObservation(runId) : Promise.resolve(null),
      ]);
      if (!alive.current || version !== refreshVersion.current) return;
      if (!saving.current) setSettings(s);
      const previous = loaded.current;
      const traceRows = mergeRows(previous.traces, t.items),
        callRows = mergeRows(previous.calls, c.items);
      const traceNext =
        t.nextOffset === null || previous.traceNext === null
          ? null
          : traceRows.length;
      const callNext =
        c.nextOffset === null || previous.callNext === null
          ? null
          : callRows.length;
      loaded.current = {
        traces: traceRows,
        calls: callRows,
        traceNext,
        callNext,
      };
      setTraces(traceRows);
      setNext(traceNext);
      setCalls(callRows);
      setCallNext(callNext);
      setUsage(u);
      setPrices(p);
      setRunSummary(summary);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    }
  }, [client, queryKey, runId]);
  useEffect(() => {
    alive.current = true;
    loaded.current = {
      traces: [],
      calls: [],
      traceNext: undefined,
      callNext: undefined,
    };
    setTraces([]);
    setCalls([]);
    setCallId(null);
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    void client
      .listSessions()
      .then((result) => {
        if (alive.current) setSessions(result.sessions);
      })
      .catch(() => {});
  }, [client]);

  const saveSettings = async (
    debug: boolean,
    retentionDays = settings?.retentionDays ?? 30,
  ) => {
    if (!settings || saving.current) return;
    const previous = settings;
    saving.current = true;
    setSettingsBusy(true);
    setSettings({ ...settings, debug, retentionDays });
    try {
      const saved = await client.saveObservationSettings({
        requestId: crypto.randomUUID(),
        expectedRevision: previous.revision,
        debug,
        retentionDays,
      });
      setSettings({ ...previous, ...saved });
    } catch (e) {
      setSettings(previous);
      setError(errorText(e));
    } finally {
      saving.current = false;
      setSettingsBusy(false);
    }
  };
  // 一个任务只有一个列表入口；真实恢复段仍保留独立身份，选择后逐段查看，不伪造合并 Span。
  const grouped = new Map<string, TraceRecord[]>();
  for (const trace of traces) {
    const key = taskKey(trace),
      items = grouped.get(key) ?? [];
    items.push(trace);
    grouped.set(key, items);
  }
  return (
    <Modal title={runId ? "执行追踪" : "执行记录与用量"} onClose={onClose} wide>
      <div className="observation-view">
        <div className="observation-toolbar">
          <label className="obs-toggle">
            <input
              type="checkbox"
              checked={settings?.debug ?? false}
              disabled={!settings || settingsBusy}
              onChange={(e) => void saveSettings(e.target.checked)}
            />
            调试模式 · 采集后续请求原始正文
          </label>
          <button type="button" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        <p className="muted">
          原始材料仅在本机保存；认证头不记录。关闭后保留已采集材料，开启前的数据无法补录。
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {usage && (
          <div className="obs-metrics">
            <div>
              <strong>{usage.total.requests}</strong>
              <span>模型请求</span>
            </div>
            <div>
              <strong>
                {(
                  usage.total.inputTokens + usage.total.outputTokens
                ).toLocaleString()}
              </strong>
              <span>已知 token · {usage.total.unknownUsage} 次未知</span>
            </div>
            <div>
              <strong>{costText(usage.total)}</strong>
              <span>估算小计 · {usage.total.unpricedRequests} 次未计价</span>
            </div>
            <div>
              <strong>{cacheText(usage.total)}</strong>
              <span>
                {usage.total.cache?.readTokens.toLocaleString() ?? "未知"} /{" "}
                {usage.total.cache?.inputTokens.toLocaleString() ?? "未知"}{" "}
                已知输入 token
              </span>
            </div>
          </div>
        )}
        <nav className="obs-tabs">
          {[
            ["traces", "执行时间轴"],
            ["calls", "模型请求"],
            ["usage", "用量统计"],
            ["prices", "模型价格"],
            ["settings", "保留设置"],
          ].map(([key, label]) => (
            <button
              type="button"
              key={key}
              aria-pressed={tab === key}
              onClick={() => setTab(key!)}
            >
              {label}
            </button>
          ))}
        </nav>
        {tab !== "prices" && tab !== "settings" && (
          <div className="obs-filters">
            {!runId && (
              <select
                aria-label="筛选会话"
                value={filter.sessionId}
                onChange={(e) =>
                  setFilter({ ...filter, sessionId: e.target.value })
                }
              >
                <option value="">全部会话（含后台）</option>
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title}
                  </option>
                ))}
              </select>
            )}
            <input
              aria-label="筛选模型"
              placeholder="模型 ID"
              value={filter.model}
              onChange={(e) => setFilter({ ...filter, model: e.target.value })}
            />
            <select
              aria-label="筛选状态"
              value={filter.status}
              onChange={(e) => setFilter({ ...filter, status: e.target.value })}
            >
              <option value="">全部状态</option>
              {[
                "running",
                "succeeded",
                "failed",
                "cancelled",
                "interrupted",
                "waiting_context",
                "waiting_approval",
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <select
              aria-label="筛选用途"
              value={filter.purpose}
              onChange={(e) =>
                setFilter({ ...filter, purpose: e.target.value })
              }
            >
              <option value="">全部用途</option>
              {["agent", "summary", "memory", "connection_test"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <input
              aria-label="开始日期"
              type="date"
              value={filter.from}
              onChange={(e) => setFilter({ ...filter, from: e.target.value })}
            />
            <input
              aria-label="结束日期"
              type="date"
              value={filter.to}
              onChange={(e) => setFilter({ ...filter, to: e.target.value })}
            />
          </div>
        )}
        {tab === "traces" && (
          <section className="obs-task-list" aria-label="追踪任务列表">
            {[...grouped].map(([key, items]) => {
              const t = items[0]!;
              const state = t.task?.status ?? t.status;
              const first = items.at(-1)!;
              const session = sessions.find((s) => s.id === t.scope.sessionId);
              return (
                <article className="obs-task" key={key}>
                  <div className="obs-task-header">
                    <div>
                      <strong>
                        {t.scope.runId
                          ? "任务"
                          : (t.scope.purpose ?? "后台记录")}{" "}
                        · {statusText(state)}
                        {session ? ` · ${session.title}` : ""}
                      </strong>
                      <small>
                        {new Date(first.startedAt).toLocaleString()}
                        {items.length > 1
                          ? ` · 已加载 ${items.length} 个执行段`
                          : ""}
                      </small>
                      <code>{key.slice(0, 12)}</code>
                    </div>
                    <a
                      href={traceHref(first.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开链路
                      <ExternalLink size={13} />
                    </a>
                  </div>
                  {items.length > 1 && (
                    <details>
                      <summary>全部已加载执行段</summary>
                      {[...items].reverse().map((segment, index) => (
                        <a
                          key={segment.id}
                          href={traceHref(segment.id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span>
                            {index + 1} ·{" "}
                            {new Date(segment.startedAt).toLocaleTimeString()} ·{" "}
                            {statusText(segment.status)}
                          </span>
                          <code>{segment.id.slice(0, 12)}</code>
                        </a>
                      ))}
                    </details>
                  )}
                </article>
              );
            })}
            {!traces.length && (
              <p className="muted">暂无追踪记录。升级前的运行未采集 Trace。</p>
            )}
            {next !== null && (
              <button
                type="button"
                onClick={() =>
                  void client
                    .traces({ ...query, offset: next })
                    .then((p) => {
                      const rows = mergeRows(loaded.current.traces, p.items);
                      loaded.current = {
                        ...loaded.current,
                        traces: rows,
                        traceNext: p.nextOffset,
                      };
                      setTraces(rows);
                      setNext(p.nextOffset);
                    })
                    .catch((e) => setError(errorText(e)))
                }
              >
                更多记录
              </button>
            )}
          </section>
        )}
        {tab === "traces" && runSummary && (
          <details className="obs-detail">
            <summary>
              阶段耗时 · 总历时 {duration(runSummary.wallMs)} · 执行段{" "}
              {duration(runSummary.executionMs)}
            </summary>
            <p>
              累计工作量会计入并行执行；占用时长合并重叠区间，自身耗时扣除子节点区间。模型耗时含网络传输，不等于纯推理时间。
            </p>
            <table className="obs-table">
              <thead>
                <tr>
                  <th>阶段</th>
                  <th>次数</th>
                  <th>累计工作量</th>
                  <th>占用时长</th>
                  <th>自身耗时</th>
                </tr>
              </thead>
              <tbody>
                {runSummary.stages.map((row) => (
                  <tr key={row.name}>
                    <td>{title(row.name)}</td>
                    <td>{row.count}</td>
                    <td>{duration(row.workMs)}</td>
                    <td>{duration(row.occupiedMs)}</td>
                    <td>{duration(row.selfMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
        {tab === "calls" && (
          <>
            <table className="obs-table">
              <thead>
                <tr>
                  <th>时间 / 模型</th>
                  <th>用途 / 状态</th>
                  <th>用量</th>
                  <th>费用</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {new Date(c.startedAt).toLocaleString()}
                      <small>{c.model}</small>
                    </td>
                    <td>
                      {c.scope.purpose ?? "agent"} / {c.status}
                    </td>
                    <td>
                      {c.usage
                        ? `${c.usage.inputTokens} / ${c.usage.outputTokens}`
                        : "未知"}
                    </td>
                    <td>
                      {c.cost === null ? "未计价" : `${c.currency} ${c.cost}`}
                    </td>
                    <td>
                      <button type="button" onClick={() => setCallId(c.id)}>
                        查看请求
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {callNext !== null && (
              <button
                type="button"
                onClick={() =>
                  void client
                    .modelCalls({ ...query, offset: callNext })
                    .then((p) => {
                      const rows = mergeRows(loaded.current.calls, p.items);
                      loaded.current = {
                        ...loaded.current,
                        calls: rows,
                        callNext: p.nextOffset,
                      };
                      setCalls(rows);
                      setCallNext(p.nextOffset);
                    })
                }
              >
                更多请求
              </button>
            )}
          </>
        )}
        {tab === "calls" && callId && (
          <ModelCallDetails key={callId} client={client} callId={callId} />
        )}
        {tab === "usage" && usage && (
          <>
            <p className="muted">
              从 {new Date(usage.startedAt).toLocaleString()}{" "}
              开始采集。删除会话后的匿名消耗仍计入总量；不同币种分别统计。
            </p>
            <table className="obs-table">
              <thead>
                <tr>
                  <th>日期 / 模型 / 用途</th>
                  <th>请求</th>
                  <th>输入 / 输出</th>
                  <th>已知费用</th>
                </tr>
              </thead>
              <tbody>
                {usage.groups.map((g) => (
                  <tr key={g.key}>
                    <td>{g.key.split("|").join(" · ")}</td>
                    <td>{g.requests}</td>
                    <td>
                      {g.inputTokens} / {g.outputTokens}
                    </td>
                    <td>
                      {costText(g)} · {g.unpricedRequests} 未计价
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {tab === "prices" && (
          <>
            <p className="muted">
              价格按每百万 token
              填写，仅影响后续请求。官方参考项缺少适用条件时不会自动套价。
            </p>
            <form
              className="obs-price-form"
              onSubmit={(e) => {
                e.preventDefault();
                void client
                  .saveModelPrice(
                    {
                      ...form,
                      cacheRead: form.cacheRead || null,
                      cacheWrite: form.cacheWrite || null,
                    },
                    priceRevision,
                  )
                  .then((p) => {
                    setPriceRevision(p.revision);
                    void refresh();
                  })
                  .catch((e) => setError(errorText(e)));
              }}
            >
              {(
                [
                  ["connection", "接口基础地址"],
                  ["model", "模型 ID"],
                  ["input", "普通输入单价"],
                  ["output", "输出单价"],
                  ["cacheRead", "缓存读取单价（空为输入价）"],
                  ["cacheWrite", "缓存写入单价（空为输入价）"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    value={form[key]}
                    required={key !== "cacheRead" && key !== "cacheWrite"}
                    onChange={(e) => {
                      setForm({ ...form, [key]: e.target.value });
                      if (key === "connection" || key === "model")
                        setPriceRevision(0);
                    }}
                  />
                </label>
              ))}
              <label>
                币种
                <select
                  value={form.currency}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      currency: e.target.value as "USD" | "CNY",
                    })
                  }
                >
                  <option>USD</option>
                  <option>CNY</option>
                </select>
              </label>
              <button type="submit">保存价格</button>
            </form>
            <table className="obs-table">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>输入 / 缓存读 / 缓存写 / 输出</th>
                  <th>来源与状态</th>
                </tr>
              </thead>
              <tbody>
                {prices.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.model}
                      <small>{p.connection}</small>
                    </td>
                    <td>
                      {p.currency} {p.input} / {p.cacheRead ?? "同输入"} /{" "}
                      {p.cacheWrite ?? "同输入"} / {p.output}
                    </td>
                    <td>
                      {p.builtin ? "官方参考" : "手动价格"} · {p.verifiedAt}
                      <small>{p.condition ?? "已配置"}</small>
                      <button
                        type="button"
                        onClick={() => {
                          setForm({
                            connection: p.connection,
                            model: p.model,
                            currency: p.currency,
                            input: p.input,
                            output: p.output,
                            cacheRead: p.cacheRead ?? "",
                            cacheWrite: p.cacheWrite ?? "",
                          });
                          setPriceRevision(p.builtin ? 0 : p.revision);
                        }}
                      >
                        填写 / 编辑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {tab === "settings" && settings && (
          <>
            <p>
              已保存原始材料：{(settings.captureBytes / 1048576).toFixed(2)}{" "}
              MiB；诊断缺损：{settings.dropped} 条。
            </p>
            {settings.ledgerFailed && (
              <p role="alert">
                用量账本写入失败，已阻止新的付费请求；请检查存储并重启服务核对。
              </p>
            )}
            <p>
              OTLP：{settings.exportEnabled ? "已开启" : "已关闭"}；成功导出{" "}
              {settings.exporter?.exportedSpans ?? 0} 个节点，失败{" "}
              {settings.exporter?.failedBatches ?? 0} 批。
            </p>
            <label>
              Trace 与原始材料保留天数
              <input
                type="number"
                min={1}
                max={3650}
                defaultValue={settings.retentionDays}
                onBlur={(e) => {
                  const days = Number(e.target.value);
                  if (days !== settings.retentionDays)
                    void saveSettings(settings.debug, days);
                }}
              />
            </label>
            <p>
              默认每份输入／输出最多 20 MiB，原始材料总预算 1
              GiB，可由服务端配置。用量账本长期保留；清理 Trace 不删除聊天历史。
            </p>
            <p>
              OTLP
              由服务端环境配置，默认关闭，只发送元数据。原始正文、认证头和文件内容不会随
              Trace 外发。
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
