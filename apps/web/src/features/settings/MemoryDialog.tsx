/**
 * 长期记忆管理页：全局/会话开关、正文与来源、人工修订、后台队列和独立用量。
 * Web 只经 SDK 访问；轮询更新列表不覆盖编辑草稿，原始模型输入与凭证从不进入页面。
 */

import type {
  ChatClient,
  MemoryEntry,
  MemoryKind,
  MemoryOverview,
  MemoryPage,
  MemoryRead,
  MemorySettings,
  Session,
  SessionMemorySettings,
  Workspace,
} from "@myagent/sdk";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../../components/Modal.js";
import { Markdown } from "../chat/Markdown.js";

const kinds: Record<MemoryKind, string> = {
  preference: "用户偏好",
  project: "项目知识",
  experience: "工作经验",
  decision: "关键决策",
};
const statuses: Record<string, string> = {
  queued: "排队",
  running: "整理中",
  yielded: "等待前台任务结束",
  waiting_budget: "等待额度",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  cancelled: "已取消",
  stale: "来源已变化",
};
const empty = {
  title: "",
  text: "",
  kind: "experience" as MemoryKind,
  project: "",
};
export function MemoryDialog({
  client,
  sessionId,
  onClose,
}: {
  client: ChatClient;
  sessionId?: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<MemoryOverview | null>(null);
  const [page, setPage] = useState<MemoryPage | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Workspace[]>([]);
  const [policy, setPolicy] = useState<SessionMemorySettings | null>(null);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<MemoryEntry | null>(null);
  const [editor, setEditor] = useState(empty);
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState<MemoryRead | null>(null);
  const [jobSession, setJobSession] = useState(sessionId ?? "");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const poll = useRef(false);
  const working = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      if (poll.current || working.current) return;
      poll.current = true;
      try {
        const overview = await client.memories();
        if (!disposed) {
          setView(overview);
          setSettings((old) => old ?? overview.settings);
        }
        const entries = await client.searchMemories({
          query,
          ...(project ? { project } : {}),
          ...(cursor ? { cursor } : {}),
        });
        if (!disposed) {
          setView(overview);
          setPage(entries);
          setSettings((old) => old ?? overview.settings);
        }
      } catch (error) {
        if (!disposed) {
          setNotice((error as Error).message);
          if (cursor) setCursor(undefined);
        }
      } finally {
        poll.current = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, query, project, cursor]);
  useEffect(() => {
    let disposed = false;
    void Promise.all([
      client.listSessions(),
      client.workspaces(),
      sessionId ? client.sessionMemory(sessionId) : Promise.resolve(null),
    ])
      .then(([s, p, m]) => {
        if (!disposed) {
          setSessions(s.sessions);
          setProjects(
            p.workspaces.filter((w) => w.kind === "project" || !w.kind),
          );
          setPolicy(m);
        }
      })
      .catch((error: Error) => {
        if (!disposed) setNotice(error.message);
      });
    return () => {
      disposed = true;
    };
  }, [client, sessionId]);
  async function action(work: () => Promise<unknown>, success = "已保存") {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setNotice("");
    try {
      await work();
      const [overview, entries] = await Promise.all([
        client.memories(),
        client.searchMemories({ query, ...(project ? { project } : {}) }),
      ]);
      if (alive.current) {
        setView(overview);
        setPage(entries);
        setNotice(success);
      }
    } catch (error) {
      if (alive.current) setNotice((error as Error).message);
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function edit(entry: MemoryEntry) {
    await action(async () => {
      let value = await client.readMemory(entry.id);
      let text = value.text;
      const sources = new Map(value.entry.sources.map((s) => [s.id, s]));
      while (value.nextCursor) {
        value = await client.readMemory(entry.id, value.nextCursor);
        text += value.text;
        for (const source of value.entry.sources)
          sources.set(source.id, source);
      }
      if (alive.current) {
        setSelected({ ...value.entry, text, sources: [...sources.values()] });
        setEditor({
          title: value.entry.title,
          text,
          kind: value.entry.kind,
          project: value.entry.project ?? "",
        });
        setSource(null);
        setEditing(true);
      }
    }, "");
  }
  function saveSettings() {
    if (!settings || !view) return;
    const { revision: _, enabledAt: __, ...input } = settings;
    void action(async () => {
      const saved = await client.saveMemorySettings({
        ...input,
        expectedRevision: settings.revision,
      });
      if (alive.current) setSettings(saved);
    });
  }
  return (
    <Modal
      title="长期记忆"
      wide
      onClose={onClose}
      dirty={
        editing ||
        JSON.stringify(settings) !== JSON.stringify(view?.settings ?? null)
      }
    >
      <p className="muted">
        在新对话中复用偏好和经验。开启后会空闲整理新增内容，并产生额外模型用量。
      </p>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {view?.error && (
        <div role="alert" className="notice">
          {view.error.message}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void action(() => client.syncMemories(), "已重新同步")
            }
          >
            重试同步
          </button>
        </div>
      )}
      {!view || !settings ? (
        <p>正在读取记忆…</p>
      ) : (
        <>
          <section className="memory-section">
            <div className="memory-toggles">
              <label>
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) =>
                    setSettings({ ...settings, enabled: e.target.checked })
                  }
                />
                启用长期记忆
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.useMemories}
                  onChange={(e) =>
                    setSettings({ ...settings, useMemories: e.target.checked })
                  }
                />
                使用已有记忆
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.generateMemories}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      generateMemories: e.target.checked,
                    })
                  }
                />
                空闲自动提炼
              </label>
            </div>
            <details>
              <summary>整理预算</summary>
              <div className="memory-fields">
                <label>
                  闲置分钟
                  <input
                    type="number"
                    min={0}
                    max={10080}
                    value={settings.idleMinutes}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        idleMinutes: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  每日调用上限（UTC）
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={settings.dailyRequests}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        dailyRequests: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  每任务调用上限
                  <input
                    type="number"
                    min={2}
                    max={1000}
                    value={settings.taskRequests}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        taskRequests: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </details>
            <button type="button" disabled={busy} onClick={saveSettings}>
              保存记忆设置
            </button>
            <p className="muted">
              有效记忆 {view.entryCount} 条 · 今日整理调用 {view.todayRequests}/
              {view.settings.dailyRequests} 次 · 累计整理 token：
              {view.usage?.totalTokens ?? "未知"}
            </p>
            {policy && sessionId && (
              <fieldset
                className="memory-toggles"
                aria-label="当前会话记忆设置"
              >
                <span>当前会话</span>
                <label>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={policy.useMemories}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      void action(async () => {
                        const p = await client.saveSessionMemory(sessionId, {
                          expectedRevision: policy.revision,
                          useMemories: checked,
                          contributeMemories: policy.contributeMemories,
                        });
                        if (alive.current) setPolicy(p);
                      });
                    }}
                  />
                  读取长期记忆
                </label>
                <label>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={policy.contributeMemories}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      void action(async () => {
                        const p = await client.saveSessionMemory(sessionId, {
                          expectedRevision: policy.revision,
                          useMemories: policy.useMemories,
                          contributeMemories: checked,
                        });
                        if (alive.current) setPolicy(p);
                      });
                    }}
                  />
                  贡献新记忆
                </label>
              </fieldset>
            )}
          </section>
          <details className="memory-section">
            <summary>概览与文件位置</summary>
            <Markdown content={view.summary || "还没有长期记忆。"} />
            <p className="memory-path">
              正文：{view.paths.memory}
              <br />
              概览：{view.paths.summary}
              <br />
              提炼记录：{view.paths.rollouts}
            </p>
            <p className="muted">
              正文可在本机编辑器修改；保留条目元数据。外部修改会识别为人工版本，概览自动更新。
            </p>
          </details>
          <section className="memory-section">
            <div className="memory-toolbar">
              <input
                aria-label="搜索长期记忆"
                placeholder="搜索偏好、项目或关键词"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(undefined);
                }}
              />
              <select
                aria-label="记忆项目筛选"
                value={project}
                onChange={(e) => {
                  setProject(e.target.value);
                  setCursor(undefined);
                }}
              >
                <option value="">全部项目</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.path}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setSelected(null);
                  setEditor(empty);
                  setEditing(true);
                  setSource(null);
                }}
              >
                新增记忆
              </button>
            </div>
            {!page?.entries.length && (
              <p className="muted">
                暂无匹配记忆。可以手动添加，或选择一个已结束的会话整理。
              </p>
            )}
            <div className="memory-list">
              {page?.entries.map((entry) => (
                <article key={entry.id} className="memory-card">
                  <div className="memory-card-heading">
                    <strong>{entry.title}</strong>
                    <span>
                      {entry.status === "needs_review" ? "待核实 · " : ""}
                      {kinds[entry.kind]} ·{" "}
                      {entry.manual ? "人工维护" : "自动提炼"}
                    </span>
                  </div>
                  <p>{entry.text}</p>
                  <small>
                    {entry.project ?? "通用"} · v{entry.revision}
                  </small>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void edit(entry)}
                  >
                    查看与编辑
                  </button>
                </article>
              ))}
            </div>
            {page?.nextCursor && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setCursor(page.nextCursor ?? undefined)}
              >
                下一页
              </button>
            )}
            {editing && (
              <form
                className="memory-editor"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    await client.updateMemory({
                      requestId: crypto.randomUUID(),
                      action: selected ? "edit" : "add",
                      ...(selected
                        ? {
                            id: selected.id,
                            expectedRevision: selected.revision,
                          }
                        : {}),
                      ...editor,
                      project: editor.project.trim() || null,
                    });
                    if (alive.current) setEditing(false);
                  });
                }}
              >
                <h3>{selected ? "编辑记忆" : "新增独立记忆"}</h3>
                <label>
                  标题
                  <input
                    required
                    maxLength={200}
                    value={editor.title}
                    onChange={(e) =>
                      setEditor({ ...editor, title: e.target.value })
                    }
                  />
                </label>
                <div className="memory-fields">
                  <label>
                    类型
                    <select
                      value={editor.kind}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          kind: e.target.value as MemoryKind,
                        })
                      }
                    >
                      {Object.entries(kinds).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    适用项目（空白表示通用）
                    <input
                      value={editor.project}
                      onChange={(e) =>
                        setEditor({ ...editor, project: e.target.value })
                      }
                    />
                  </label>
                </div>
                <label>
                  记忆正文
                  <textarea
                    aria-label="记忆正文"
                    required
                    rows={7}
                    maxLength={12000}
                    value={editor.text}
                    onChange={(e) =>
                      setEditor({ ...editor, text: e.target.value })
                    }
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" onClick={() => setEditing(false)}>
                    取消编辑
                  </button>
                  <button type="submit" disabled={busy}>
                    保存记忆
                  </button>
                  {selected && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await client.updateMemory({
                            requestId: crypto.randomUUID(),
                            action: "forget",
                            id: selected.id,
                            expectedRevision: selected.revision,
                          });
                          if (alive.current) setEditing(false);
                        }, "已遗忘，该旧来源不会自动重新生成")
                      }
                    >
                      忘记这条记忆
                    </button>
                  )}
                </div>
                {!!selected?.sources.length && (
                  <details>
                    <summary>来源与证据（{selected.sources.length}）</summary>
                    {selected.sources.map((s) => (
                      <p key={s.id}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              const value = await client.readMemory(
                                selected.id,
                                undefined,
                                s.id,
                              );
                              if (alive.current) setSource(value);
                            }, "")
                          }
                        >
                          查阅来源 {s.recordId.slice(0, 12)}
                        </button>{" "}
                        · {s.status} · {s.createdAt}
                      </p>
                    ))}
                    {source && (
                      <>
                        <pre className="memory-source">{source.text}</pre>
                        {source.nextCursor && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                const value = await client.readMemory(
                                  selected.id,
                                  source.nextCursor!,
                                  source.source?.id,
                                );
                                if (alive.current) setSource(value);
                              }, "")
                            }
                          >
                            继续读取来源
                          </button>
                        )}
                      </>
                    )}
                  </details>
                )}
              </form>
            )}
          </section>
          <section className="memory-section">
            <h3>整理历史会话</h3>
            <p className="muted">
              首次开启不会自动回溯旧聊天。手动整理会使用当前模型连接，额外调用在下方单独记录。
            </p>
            <div className="memory-toolbar">
              <select
                aria-label="选择待整理会话"
                value={jobSession}
                onChange={(e) => setJobSession(e.target.value)}
              >
                <option value="">选择已结束的会话</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || !jobSession || !view.settings.enabled}
                onClick={() =>
                  void action(
                    () =>
                      client.createMemoryJob(jobSession, crypto.randomUUID()),
                    "已加入整理队列",
                  )
                }
              >
                开始整理
              </button>
            </div>
            {view.jobs.map((job) => (
              <div key={job.id} className="memory-job">
                <span>
                  {sessions.find((s) => s.id === job.sessionId)?.title ??
                    "历史会话"}{" "}
                  · {statuses[job.status]} · {job.requests} 次调用 ·{" "}
                  {job.usage?.totalTokens ?? "未知"} token
                </span>
                {["queued", "running", "yielded"].includes(job.status) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(
                        () => client.cancelMemoryJob(job.id),
                        "已取消整理",
                      )
                    }
                  >
                    取消
                  </button>
                ) : [
                    "failed",
                    "interrupted",
                    "waiting_budget",
                    "cancelled",
                  ].includes(job.status) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(
                        () => client.retryMemoryJob(job.id),
                        "已请求继续",
                      )
                    }
                  >
                    重试整理
                  </button>
                ) : null}
                {job.error && <small>{job.error.message}</small>}
              </div>
            ))}
          </section>
          <details className="memory-section">
            <summary>变更记录</summary>
            {view.changes.map((change, i) => (
              <div className="memory-job" key={change.id}>
                <span>
                  {change.createdAt} · {change.reason}
                </span>
                {i === 0 && change.undoable && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(
                        () =>
                          client.undoMemory(
                            change.id,
                            view.revision,
                            crypto.randomUUID(),
                          ),
                        "已撤销变更",
                      )
                    }
                  >
                    撤销此变更
                  </button>
                )}
              </div>
            ))}
          </details>
        </>
      )}
    </Modal>
  );
}
