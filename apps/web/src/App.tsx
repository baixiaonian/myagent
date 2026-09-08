import {
  ApiError,
  applyEvent,
  ChatClient,
  type Message,
  type PublicSettings,
  type RegenerateInput,
  type RunInput,
  type Session,
  type SessionSnapshot,
} from "@myagent/sdk";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleHelp,
  Edit3,
  LoaderCircle,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "./components/Modal.js";
import { CopyButton, Markdown } from "./features/chat/Markdown.js";
import { SettingsDialog } from "./features/settings/SettingsDialog.js";

const client = new ChatClient();
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试。";
const suggestions = [
  "帮我把一个复杂概念讲清楚",
  "一起梳理一个新的想法",
  "润色一段文字，让表达更自然",
];
interface Pending {
  kind: "send" | "regenerate";
  input: RunInput | RegenerateInput;
}
function visibleAnswers(messages: Message[]): Message[] {
  return messages
    .filter((message) => message.role === "user")
    .flatMap((question) => {
      const answers = messages.filter(
        (item) =>
          item.replyToId === question.id && item.status !== "superseded",
      );
      const selected =
        answers.findLast((item) => item.status === "generating") ??
        answers.findLast((item) => item.status === "completed") ??
        answers.at(-1);
      return selected ? [question, selected] : [question];
    });
}
export default function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("session"),
  );
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("connected");
  const [reload, setReload] = useState(0);
  const [manage, setManage] = useState<{
    kind: "rename" | "delete";
    session: Session;
  } | null>(null);
  const [title, setTitle] = useState("");
  const [manageBusy, setManageBusy] = useState(false);
  const [showBottom, setShowBottom] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const scroll = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(new Map<string, Pending>());
  const draftKey = selected ?? "new";
  const draft = drafts[draftKey] ?? "";
  const busy =
    snapshot?.activeRun !== null && snapshot?.activeRun !== undefined;
  const messages = snapshot ? visibleAnswers(snapshot.messages) : [];
  const refreshList = useCallback(async () => {
    const result = await client.listSessions();
    setSessions(result.sessions);
  }, []);
  const acceptSnapshot = useCallback((next: SessionSnapshot) => {
    if (selectedRef.current !== next.session.id) return;
    setSnapshot((current) =>
      current?.session.id === next.session.id && current.cursor > next.cursor
        ? current
        : next,
    );
  }, []);
  useEffect(() => {
    let disposed = false;
    Promise.all([client.settings(), client.listSessions()])
      .then(([value, list]) => {
        if (disposed) return;
        setSettings(value);
        setSessions(list.sessions);
        if (!value.configured) setSettingsOpen(true);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(errorText(reason));
      });
    return () => {
      disposed = true;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload 是用户主动重连的触发器。
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set("session", selected);
    else url.searchParams.delete("session");
    history.replaceState({}, "", url);
    setError("");
    stickBottom.current = true;
    setShowBottom(false);
    if (!selected) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    let disposed = false;
    let unsubscribe = () => {};
    setLoading(true);
    setSnapshot(null);
    client
      .session(selected)
      .then((value) => {
        if (disposed) return;
        acceptSnapshot(value);
        setLoading(false);
        unsubscribe = client.subscribe(
          selected,
          value.cursor,
          (event) => {
            if (disposed) return;
            setSnapshot((current) =>
              current ? applyEvent(current, event) : current,
            );
            if (event.type === "session.updated")
              setSessions((items) =>
                [
                  event.session,
                  ...items.filter((item) => item.id !== event.session.id),
                ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
              );
          },
          (value) => {
            if (!disposed) setConnection(value);
          },
          (deleted) => {
            if (disposed) return;
            if (deleted) {
              setSelected(null);
              void refreshList();
            } else {
              setReload((value) => value + 1);
            }
          },
        );
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        setLoading(false);
        setError(errorText(reason));
        if (reason instanceof ApiError && reason.status === 404) {
          setSelected(null);
          void refreshList();
        }
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [selected, reload, acceptSnapshot, refreshList]);
  useEffect(() => {
    if (snapshot && stickBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 草稿改变后重新测量 textarea 的实际高度。
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`;
    }
  }, [draft]);
  async function openSettings() {
    try {
      setSettings(await client.settings());
      setSettingsOpen(true);
    } catch (reason) {
      setError(errorText(reason));
    }
  }
  function choose(id: string | null) {
    setSelected(id);
    setSidebarOpen(false);
  }
  function updateDraft(value: string) {
    setDrafts((old) => ({ ...old, [draftKey]: value }));
  }
  async function send(kind: "send" | "regenerate" = "send") {
    if (submitting || busy || loading || (kind === "send" && !draft.trim()))
      return;
    if (!settings?.configured) {
      setSettingsOpen(true);
      return;
    }
    setSubmitting(true);
    setError("");
    stickBottom.current = true;
    const text = draft.trim();
    let sourceKey = draftKey;
    let id = selected;
    try {
      let revision = snapshot?.session.revision ?? 0;
      if (!id) {
        const session = await client.createSession();
        id = session.id;
        sourceKey = session.id;
        setDrafts((old) => ({ ...old, [session.id]: old.new ?? "", new: "" }));
        revision = session.revision;
        selectedRef.current = id;
        setSelected(id);
        setSessions((old) => [session, ...old]);
      }
      const previous = pending.current.get(id);
      const same =
        previous?.kind === kind &&
        (kind === "regenerate" ||
          ("content" in previous.input && previous.input.content === text));
      const input =
        same && previous
          ? previous.input
          : {
              requestId: crypto.randomUUID(),
              expectedRevision: revision,
              ...(kind === "send" ? { content: text } : {}),
            };
      pending.current.set(id, { kind, input });
      const accepted =
        kind === "send"
          ? await client.send(id, input as RunInput)
          : await client.regenerate(id, input);
      pending.current.delete(id);
      acceptSnapshot(accepted.snapshot);
      if (kind === "send")
        setDrafts((old) => ({
          ...old,
          [sourceKey]:
            old[sourceKey]?.trim() === text ? "" : (old[sourceKey] ?? ""),
        }));
      await refreshList();
    } catch (reason) {
      if (!id || selectedRef.current === id) setError(errorText(reason));
      if (id && reason instanceof ApiError && reason.status !== 0)
        pending.current.delete(id);
      if (id) {
        try {
          acceptSnapshot(await client.session(id));
        } catch {
          /* 保留原始错误及草稿。 */
        }
      }
    } finally {
      setSubmitting(false);
    }
  }
  async function stop() {
    if (!snapshot?.activeRun) return;
    try {
      await client.cancel(snapshot.activeRun.id);
      acceptSnapshot(await client.session(snapshot.session.id));
    } catch (reason) {
      setError(errorText(reason));
    }
  }
  async function manageSession() {
    if (!manage) return;
    setManageBusy(true);
    setError("");
    try {
      if (manage.kind === "delete") {
        await client.delete(manage.session.id);
        if (selected === manage.session.id) choose(null);
        setDrafts((old) => {
          const next = { ...old };
          delete next[manage.session.id];
          return next;
        });
      } else {
        const fresh = await client.session(manage.session.id);
        await client.rename(manage.session.id, title, fresh.session.revision);
        if (selected === manage.session.id)
          acceptSnapshot(await client.session(manage.session.id));
      }
      setManage(null);
      await refreshList();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setManageBusy(false);
    }
  }
  const latest = snapshot?.latestRun;
  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭会话列表"
          className="sidebar-shade"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-symbol">
            m<span />
          </div>
          <strong>MyAgent</strong>
          <span className="local-tag">LOCAL</span>
          <button
            type="button"
            className="icon-button mobile-only"
            aria-label="收起侧栏"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button className="new-chat" type="button" onClick={() => choose(null)}>
          <Plus size={18} />
          开启新对话<span>＋</span>
        </button>
        <div className="sidebar-label">
          你的对话 <span>{sessions.length}</span>
        </div>
        <nav aria-label="会话列表" className="session-list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-row ${selected === session.id ? "selected" : ""}`}
            >
              <button
                type="button"
                className="session-select"
                onClick={() => choose(session.id)}
                title={session.title}
              >
                <MessageSquare size={15} />
                <span>{session.title}</span>
              </button>
              <div className="session-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`重命名：${session.title}`}
                  onClick={() => {
                    setTitle(session.title);
                    setManage({ kind: "rename", session });
                  }}
                >
                  <Edit3 size={13} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`删除：${session.title}`}
                  onClick={() => setManage({ kind: "delete", session })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          {!sessions.length && (
            <p className="sidebar-empty">
              从一个问题开始，
              <br />
              对话会留在这里。
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="settings-link"
            type="button"
            onClick={() => void openSettings()}
          >
            <Settings2 size={17} />
            <span>模型设置</span>
            <span
              className={`status-light ${settings?.configured ? "ready" : ""}`}
            />
          </button>
          <div className="privacy">
            <ShieldCheck size={14} />
            <span>历史记录保存在本机</span>
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="workspace-header">
          <div className="header-left">
            <button
              type="button"
              className="icon-button mobile-only"
              aria-label="打开会话列表"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={21} />
            </button>
            <button
              type="button"
              className="model-selector"
              onClick={() => void openSettings()}
            >
              {settings?.model || "选择你的模型"}
              <ChevronDown size={15} />
            </button>
          </div>
          <span className="workspace-badge">
            <span />
            个人工作空间
          </span>
        </header>
        <div
          className="conversation"
          ref={scroll}
          onScroll={() => {
            const element = scroll.current;
            if (!element) return;
            const near =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              90;
            stickBottom.current = near;
            setShowBottom(!near);
          }}
        >
          {loading ? (
            <div className="loading-state">
              <LoaderCircle className="spin" size={22} />
              正在加载对话…
            </div>
          ) : messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-mark">
                <Sparkles size={27} strokeWidth={1.5} />
              </div>
              <p className="eyebrow">A LITTLE CURIOSITY GOES A LONG WAY</p>
              <h1>今天，想聊点什么？</h1>
              <p className="welcome-description">
                一个想法、一个问题，或一段还没理清的思路。
                <br />
                从这里开始，我们一起把它想明白。
              </p>
              <div className="suggestions">
                {suggestions.map((suggestion, index) => (
                  <button
                    type="button"
                    key={suggestion}
                    onClick={() => {
                      updateDraft(suggestion);
                      textarea.current?.focus();
                    }}
                  >
                    <span>0{index + 1}</span>
                    {suggestion}
                    <ArrowUp size={15} />
                  </button>
                ))}
              </div>
              {!settings?.configured && (
                <button
                  type="button"
                  className="setup-prompt"
                  onClick={() => void openSettings()}
                >
                  <Settings2 size={15} />
                  首次使用，先连接你的模型
                  <ArrowUp size={14} />
                </button>
              )}
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`message ${message.role}`}
                  aria-label={message.role === "user" ? "你的消息" : "模型回答"}
                >
                  <div className="message-avatar">
                    {message.role === "user" ? "你" : "m"}
                  </div>
                  <div className="message-body">
                    <div className="message-author">
                      {message.role === "user" ? "你" : "MyAgent"}
                      {message.status === "generating" && (
                        <span className="generating-label">
                          <span />
                          正在生成
                        </span>
                      )}
                    </div>
                    {message.role === "user" ? (
                      <div className="user-text">{message.content}</div>
                    ) : message.content ? (
                      <Markdown content={message.content} />
                    ) : message.status === "generating" ? (
                      <div className="thinking-dots">
                        <span />
                        <span />
                        <span />
                      </div>
                    ) : (
                      <p className="muted">这次没有生成完整回答。</p>
                    )}
                    {["cancelled", "interrupted", "failed"].includes(
                      message.status,
                    ) && (
                      <p className="message-status">
                        {message.status === "cancelled"
                          ? "已停止生成"
                          : message.status === "interrupted"
                            ? "生成已中断"
                            : "生成失败"}
                      </p>
                    )}
                    {message.content && message.status !== "generating" && (
                      <div className="message-tools">
                        <CopyButton
                          text={() => message.content}
                          label="复制消息"
                        />
                        {message.role === "assistant" &&
                          message.replyToId === latest?.userMessageId && (
                            <button
                              type="button"
                              className="copy-button"
                              disabled={busy || submitting}
                              onClick={() => void send("regenerate")}
                            >
                              <RefreshCw size={14} />
                              重新生成
                            </button>
                          )}
                      </div>
                    )}
                  </div>
                </article>
              ))}
              {latest?.contextTrimmed && (
                <p className="context-note">
                  <CircleHelp size={14} />
                  较早的完整问答未带入本次回答；历史仍保存在本机。
                </p>
              )}
              {latest?.finishReason === "length" && (
                <p className="context-note">
                  回答达到模型输出上限，可重新生成或继续提问。
                </p>
              )}
              {latest?.error && !busy && (
                <div className="run-error" role="status">
                  <span>{latest.error.message}</span>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void send("regenerate")}
                  >
                    <RefreshCw size={14} />
                    重试回答
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="composer-area">
          {showBottom && (
            <button
              type="button"
              className="scroll-bottom icon-button"
              aria-label="回到底部"
              onClick={() => {
                stickBottom.current = true;
                if (scroll.current)
                  scroll.current.scrollTop = scroll.current.scrollHeight;
                setShowBottom(false);
              }}
            >
              <ArrowDown size={18} />
            </button>
          )}
          {connection === "reconnecting" && selected && (
            <div className="connection-note">
              <LoaderCircle className="spin" size={13} />
              正在重新连接本地服务…
              <button
                type="button"
                onClick={() => setReload((value) => value + 1)}
              >
                重新加载
              </button>
            </div>
          )}
          {error && (
            <div className="notice error composer-error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭错误提示"
                onClick={() => setError("")}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <form
            className={`composer ${busy ? "working" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={textarea}
              value={draft}
              onChange={(event) => updateDraft(event.target.value)}
              placeholder={
                busy ? "先写下你的下一个问题…" : "输入消息，开启对话…"
              }
              aria-label="输入消息"
              rows={1}
              maxLength={8000}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !composing.current &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-bottom">
              <span className="composer-hint">
                {draft.length > 7000
                  ? `${draft.length} / 8000`
                  : "Shift + Enter 换行"}
              </span>
              {busy ? (
                <button
                  type="button"
                  className="send-button stop"
                  aria-label="停止生成"
                  onClick={() => void stop()}
                >
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  aria-label="发送消息"
                  disabled={!draft.trim() || submitting || loading}
                >
                  {submitting ? (
                    <LoaderCircle className="spin" size={19} />
                  ) : (
                    <ArrowUp size={21} />
                  )}
                </button>
              )}
            </div>
          </form>
          <p className="composer-footnote">
            AI 的回答可能不准确，请核对重要信息。
            <span>
              <ShieldCheck size={12} /> 本地存储 · 自有模型
            </span>
          </p>
        </div>
      </main>
      {settingsOpen && settings && (
        <SettingsDialog
          client={client}
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {settingsOpen && !settings && (
        <Modal title="连接本地服务" onClose={() => setSettingsOpen(false)}>
          <p>暂时无法读取模型设置，请确认本地服务已启动。</p>
          <button
            type="button"
            className="button primary"
            onClick={() => location.reload()}
          >
            重新加载
          </button>
        </Modal>
      )}
      {manage && (
        <Modal
          title={manage.kind === "rename" ? "重命名对话" : "删除对话"}
          onClose={() => setManage(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void manageSession();
            }}
          >
            {manage.kind === "rename" ? (
              <label>
                对话标题
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={100}
                  required
                />
              </label>
            ) : (
              <p>
                确定删除「{manage.session.title}
                」吗？这会删除本机的全部相关消息；正在生成的回答会先停止。
              </p>
            )}
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => setManage(null)}
              >
                取消
              </button>
              <button
                className={`button ${manage.kind === "delete" ? "danger-button" : "primary"}`}
                type="submit"
                disabled={
                  manageBusy || (manage.kind === "rename" && !title.trim())
                }
              >
                {manageBusy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Check size={16} />
                )}
                {manage.kind === "rename" ? "保存名称" : "删除对话"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
