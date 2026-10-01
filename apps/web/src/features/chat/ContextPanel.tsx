/**
 * 聊天输入区的上下文状态：只经 SDK 查询估算与摘要，历史正文按需分页。
 * 切换会话后丢弃旧异步响应；不存密钥、不改输入草稿、不把摘要伪装成聊天消息。
 */
import type {
  ChatClient,
  ContextView,
  HistoryPage,
  SessionSnapshot,
} from "@myagent/sdk";
import { useEffect, useRef, useState } from "react";
export function ContextPanel({
  client,
  snapshot,
  onRefresh,
}: {
  client: ChatClient;
  snapshot: SessionSnapshot;
  onRefresh: () => void;
}) {
  const sessionId = snapshot.session.id;
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const [view, setView] = useState<ContextView | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryPage | null>(null);
  const [source, setSource] = useState("");
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // 轻量明细不占对话高度；Escape 回到触发点，点击外部仅关闭展示，不改变任务。
    const dismiss = (event: PointerEvent | KeyboardEvent | FocusEvent) => {
      const panel = disclosure.current;
      if (!panel?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        panel.open = false;
        panel.querySelector("summary")?.focus();
      } else if (event.target instanceof Node && !panel.contains(event.target))
        panel.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    let pending = false;
    setView(null);
    setHistory(null);
    setNotice("");
    setBusy(false);
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await client.context(sessionId);
        if (alive) setView(value);
      } catch (error) {
        if (alive)
          setNotice(
            error instanceof Error ? error.message : "上下文状态读取失败。",
          );
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, sessionId]);
  async function resume(action: "retry" | "apply_capacity") {
    if (!view) return;
    setBusy(true);
    setNotice("");
    try {
      await client.resume(view.runId, {
        requestId: crypto.randomUUID(),
        contextAction: action,
      });
      onRefresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "恢复失败。");
    } finally {
      setBusy(false);
    }
  }
  async function readSource(id: string, cursor?: string) {
    setBusy(true);
    setNotice("");
    try {
      const page = await client.history(sessionId, {
        sourceId: id,
        includeSuperseded: true,
        ...(cursor ? { cursor } : {}),
      });
      if (currentSession.current === sessionId) {
        setSource(id);
        setHistory(page);
      }
    } catch (error) {
      if (currentSession.current === sessionId)
        setNotice(error instanceof Error ? error.message : "历史读取失败。");
    } finally {
      if (currentSession.current === sessionId) setBusy(false);
    }
  }
  if (!view) return notice ? <p role="status">{notice}</p> : null;
  const stats = view.stats;
  const windowTokens = view.capacity?.contextWindowTokens;
  const percent =
    stats && windowTokens
      ? Math.round((stats.estimatedTokens / windowTokens) * 100)
      : null;
  const paused = snapshot.activeRun?.status === "waiting_context";
  return (
    <aside className="context-panel" aria-label="上下文管理">
      <details ref={disclosure} className="context-disclosure">
        <summary
          title={
            percent === null
              ? "查看上下文状态"
              : `完整窗口约占用 ${percent}% · 点击查看明细`
          }
        >
          <span
            className="context-meter"
            aria-hidden="true"
            style={{
              background:
                percent === null
                  ? undefined
                  : `conic-gradient(currentColor ${Math.min(percent, 100)}%, var(--line) 0)`,
            }}
          />
          <span className="context-reading">
            {view.status === "compacting"
              ? "正在整理上下文…"
              : percent !== null
                ? `上下文 ${percent}%`
                : "上下文待估算"}
          </span>
          <span className="context-summary-count">
            {view.summaries.length > 0
              ? ` · ${view.summaries.length} 份摘要`
              : ""}
          </span>
        </summary>
        <div className="context-popover">
          <div className="context-popover-heading">
            <strong>上下文窗口</strong>
            <span>
              {percent === null ? "尚无估算" : `约 ${percent}% 已使用`}
            </span>
          </div>
          {stats && (
            <>
              <p className="context-figures">
                {stats.estimatedTokens.toLocaleString()}{" "}
                <span>/ {windowTokens?.toLocaleString() ?? "未知"} tokens</span>
              </p>
              {windowTokens && (
                <progress
                  aria-label="上下文窗口占用"
                  value={stats.estimatedTokens}
                  max={windowTokens}
                />
              )}
            </>
          )}
          <p className="field-hint">
            用量为最近一次准备模型请求时的估算。完整窗口包含输出预留和安全余量；可用输入预算{" "}
            {stats?.inputBudget.toLocaleString() ?? "未知"}{" "}
            token。历史压缩不会删除原记录。
          </p>
          {stats && (
            <dl className="context-breakdown">
              <dt>指令及规则</dt>
              <dd>约 {stats.breakdown.instructions}</dd>
              <dt>技能目录与说明</dt>
              <dd>约 {stats.breakdown.skills ?? 0}</dd>
              <dt>Hook</dt>
              <dd>约 {stats.breakdown.hooks ?? 0}</dd>
              <dt>工具定义</dt>
              <dd>约 {stats.breakdown.tools}</dd>
              <dt>对话投影</dt>
              <dd>约 {stats.breakdown.conversation}</dd>
            </dl>
          )}
          {!!view.skills?.active.length && (
            <section className="skill-usage" aria-label="本轮已加载技能">
              {view.skills.active.map((skill) => (
                <p key={skill.id}>
                  已加载 {skill.name} ·{" "}
                  {skill.explicit ? "用户选择" : "模型选择"} ·{" "}
                  {skill.packageVersion.slice(0, 8)}
                </p>
              ))}
            </section>
          )}
          {view.ruleSource && (
            <p className="field-hint">
              项目规则：{view.ruleSource.path}（{view.ruleSource.bytes} 字节）
            </p>
          )}
          <p className="field-hint">
            整理请求 {view.compactionRequests} 次 · 整理用量{" "}
            {view.compactionUsage?.totalTokens ?? "未知"} token · 总用量{" "}
            {view.totalUsage?.totalTokens ?? "待完成或未知"} token
          </p>
          {view.summaries.map((summary) => (
            <details key={summary.id}>
              <summary>
                查看摘要 · 覆盖 {summary.sourceIds.length} 条来源
              </summary>
              <pre className="context-text">{summary.text}</pre>
              <p className="field-hint">
                摘要可能基于结果预览，必要时查阅原文。
              </p>
              <div className="context-sources">
                {summary.sourceIds.map((id) => (
                  <button
                    type="button"
                    key={id}
                    disabled={busy}
                    onClick={() => void readSource(id)}
                  >
                    查阅 {id.slice(-16)}
                  </button>
                ))}
              </div>
            </details>
          ))}
          {history && (
            <div>
              <h4>历史原文</h4>
              {history.entries.map((entry) => (
                <pre className="context-text" key={entry.sourceId}>
                  {entry.kind} · {entry.status}{" "}
                  {entry.answerStatus
                    ? `（回答分支：${entry.answerStatus}）`
                    : ""}
                  {"\n"}
                  {entry.text}
                  {entry.truncated ? "\n[本页未完]" : ""}
                </pre>
              ))}
              {!history.entries.length && <p>该来源没有可显示的原文。</p>}
              {history.nextCursor && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void readSource(source, history.nextCursor ?? undefined)
                  }
                >
                  继续读取
                </button>
              )}
            </div>
          )}
        </div>
      </details>
      {view.error && <p role="status">{view.error.message}</p>}
      {paused && (
        <div className="context-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void resume("retry")}
          >
            重试整理上下文
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void resume("apply_capacity")}
          >
            应用最新容量并继续
          </button>
          <small>
            可先在模型设置中调整容量；继续使用本次运行的原模型和项目规则。
          </small>
        </div>
      )}
      {notice && <p role="alert">{notice}</p>}
    </aside>
  );
}
