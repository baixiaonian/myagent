/** 团队面板：成员与消息均取服务端事实；查看不会创建会话，审批仍使用唯一执行界面。 */
import type {
  AgentHistoryPage,
  ChatClient,
  SessionSnapshot,
  TeamMember,
  TeamMessage,
  TeamView,
} from "@myagent/sdk";
import { Bot, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ExecutionPanel } from "../tools/ExecutionPanel.js";
import { ContextPanel } from "./ContextPanel.js";
import { Markdown } from "./Markdown.js";
import { RunProcess } from "./RunProcess.js";

const labels: Record<string, string> = {
  idle: "空闲",
  queued: "排队",
  working: "工作中",
  closed: "已关闭",
  stopping: "正在停止",
  running: "运行中",
  waiting_agents: "等待成员",
  waiting_approval: "等待审批",
  waiting_context: "等待整理上下文",
  waiting_reconciliation: "需要核对",
  recoverable: "待恢复",
  cleaning: "收尾中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
  interrupted: "已中断",
};
export function TeamPanel({
  client,
  snapshot,
  onRefresh,
  open,
  onClose,
  onCount,
}: {
  client: ChatClient;
  snapshot: SessionSnapshot;
  onRefresh: () => void;
  open: boolean;
  onClose: () => void;
  onCount: (count: number) => void;
}) {
  const [team, setTeam] = useState<TeamView | null>(null),
    [messages, setMessages] = useState<TeamMessage[]>([]),
    [error, setError] = useState(""),
    [selected, setSelected] = useState("");
  const [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const historyLoaded = useRef(false);
  useEffect(() => {
    historyLoaded.current = false;
    let alive = true,
      pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const [value, page] = await Promise.all([
          client.team(snapshot.session.id),
          client.teamMessages(snapshot.session.id),
        ]);
        if (alive) {
          setTeam(value);
          onCount(value.members.length);
          setMessages((old) =>
            [
              ...new Map(
                [...old, ...page.items].map((m) => [m.id, m]),
              ).values(),
            ].sort((a, b) => a.sequence - b.sequence),
          );
          if (!historyLoaded.current) setCursor(page.cursor);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "无法读取团队。");
      } finally {
        pending = false;
      }
    };
    setTeam(null);
    setSelected("");
    setMessages([]);
    setError("");
    void read();
    const timer = setInterval(() => void read(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, snapshot.session.id, onCount]);
  const stop = async (member: TeamMember, close = false) => {
    setBusy(true);
    try {
      setTeam(
        await client.stopAgent(snapshot.session.id, member.id, {
          requestId: crypto.randomUUID(),
          expectedRevision: member.revision,
          close,
        }),
      );
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法停止成员。");
    } finally {
      setBusy(false);
    }
  };
  if (!open) return null;
  if (!team?.members.length)
    return error ? (
      <aside className="team-rail">
        <p role="alert">{error}</p>
        <button type="button" onClick={onClose}>
          关闭团队侧栏
        </button>
      </aside>
    ) : null;
  const name = (id: string) =>
    id === "main"
      ? "主 Agent"
      : (team.members.find((m) => m.id === id)?.name ?? id);
  return (
    <aside
      className="team-rail"
      aria-label="团队侧栏"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
          document.querySelector<HTMLButtonElement>(".team-toggle")?.focus();
        }
      }}
    >
      <header className="team-rail-heading">
        <span>
          <Users size={17} />
          协作团队
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭团队侧栏"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <details className="team-panel" open>
        <summary>
          团队 · {team.members.filter((m) => m.status !== "closed").length}{" "}
          位成员{" "}
          {team.members.some((m) => m.status === "closed") && (
            <span className="muted">
              （{team.members.filter((m) => m.status === "closed").length}{" "}
              位已关闭）
            </span>
          )}
          <span className="muted">
            {snapshot.activeRun?.status === "waiting_agents"
              ? "正在收集成员结果"
              : ""}
          </span>
        </summary>
        {error && <p role="alert">{error}</p>}
        <div className="team-members">
          {team.members.map((member) => (
            <article key={member.id} className="team-member">
              <header>
                <span className="member-avatar">
                  <Bot size={16} />
                </span>
                <strong>{member.name}</strong>
                <span
                  className="member-status"
                  data-status={member.runStatus ?? member.status}
                >
                  {labels[
                    member.status === "closed" ||
                    member.status === "stopping" ||
                    member.status === "queued"
                      ? member.status
                      : (member.runStatus ?? member.status)
                  ] ?? member.status}
                </span>
              </header>
              <p className="member-task">{member.task}</p>
              {member.error && <p role="alert">{member.error.message}</p>}
              <details>
                <summary>角色与上下文</summary>
                <p>{member.instructions}</p>
                <small>
                  {member.context.mode === "brief"
                    ? "仅任务说明"
                    : member.context.mode === "recent"
                      ? "最近对话"
                      : "完整可见历史"}{" "}
                  · 独立上下文 · 共享当前项目
                </small>
              </details>
              <div className="team-actions">
                <button
                  type="button"
                  onClick={() =>
                    setSelected(selected === member.id ? "" : member.id)
                  }
                >
                  {selected === member.id ? "收起过程" : "查看过程"}
                </button>
                {member.status !== "closed" && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void stop(member)}
                    >
                      停止工作
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void stop(member, true)}
                    >
                      关闭成员
                    </button>
                  </>
                )}
              </div>
              <small className="muted">
                用量：
                {member.usage
                  ? `${member.usage.totalTokens} tokens`
                  : "未知或尚未完成"}
              </small>
              {selected === member.id && (
                <MemberDetail
                  key={member.id}
                  client={client}
                  sessionId={snapshot.session.id}
                  member={member}
                />
              )}
            </article>
          ))}
        </div>
        <details>
          <summary>成员通信</summary>
          {messages.map((message) => (
            <article className="team-message" key={message.id}>
              <strong>
                {name(message.from)} → {name(message.to)}
              </strong>
              <small>
                {message.kind === "request"
                  ? "请求"
                  : message.kind === "result"
                    ? "完成回执"
                    : "信息"}{" "}
                ·{" "}
                {message.repliedBy
                  ? "已回复"
                  : message.includedRunId
                    ? "已纳入模型请求"
                    : "已入队"}
              </small>
              <pre>{message.content}</pre>
            </article>
          ))}
          {cursor && (
            <button
              type="button"
              onClick={() => {
                void client
                  .teamMessages(snapshot.session.id, cursor)
                  .then((page) => {
                    historyLoaded.current = true;
                    setMessages((old) =>
                      [
                        ...new Map(
                          [...page.items, ...old].map((m) => [m.id, m]),
                        ).values(),
                      ].sort((a, b) => a.sequence - b.sequence),
                    );
                    setCursor(page.cursor);
                  })
                  .catch((e) => setError(String(e)));
              }}
            >
              读取较早的通信记录
            </button>
          )}
        </details>
        <p className="muted">
          本轮团队用量：
          {team.usage
            ? `${team.usage.totalTokens} tokens`
            : "部分请求用量未知或尚未完成"}
          。成员的建议不代替用户授权。
        </p>
      </details>
    </aside>
  );
}
/** 成员详情按需打开；异步返回必须绑定当前成员，旧响应不能写进另一成员的视图。 */
function MemberDetail({
  client,
  sessionId,
  member,
}: {
  client: ChatClient;
  sessionId: string;
  member: TeamMember;
}) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null),
    [page, setPage] = useState<AgentHistoryPage | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  // 人工刷新信号有意使历史首页重新取样；展开期间持续获取模型和工具过程。
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision 是人工刷新失效信号。
  useEffect(() => {
    let alive = true,
      pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const [s, p] = await Promise.all([
          client.session(member.internalSessionId),
          client.agentHistory(sessionId, member.id),
        ]);
        if (alive) {
          setSnapshot(s);
          setPage((old) => old ?? p);
          setError("");
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        pending = false;
      }
    };
    setPage(null);
    void read();
    const timer = setInterval(() => void read(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, member.id, member.internalSessionId, sessionId, revision]);
  return (
    <section aria-label={`${member.name} 的执行过程`}>
      <button type="button" onClick={() => setRevision((v) => v + 1)}>
        刷新过程
      </button>
      {error && <p role="alert">{error}</p>}
      {snapshot && (
        <>
          <ExecutionPanel
            client={client}
            snapshot={snapshot}
            onRefresh={() => setRevision((v) => v + 1)}
          />
          <ContextPanel
            client={client}
            snapshot={snapshot}
            onRefresh={() => setRevision((v) => v + 1)}
          />
        </>
      )}
      {snapshot && (
        <>
          <RunProcess
            active={Boolean(snapshot.activeRun)}
            client={client}
            sessionId={member.internalSessionId}
            steps={snapshot.steps ?? []}
          />
          <Markdown
            content={
              snapshot.messages.filter((m) => m.role === "assistant").at(-1)
                ?.content ?? ""
            }
          />
        </>
      )}
      <details>
        <summary>历史原文（分页）</summary>
        {page?.records.map((record) => (
          <pre key={JSON.stringify(record)}>
            {typeof record === "object" && record && "text" in record
              ? String(record.text)
              : JSON.stringify(record)}
          </pre>
        ))}
        {page?.cursor && (
          <button
            type="button"
            onClick={() => {
              void client
                .agentHistory(sessionId, member.id, page.cursor ?? "0:0")
                .then((next) =>
                  setPage({
                    records: [...page.records, ...next.records],
                    cursor: next.cursor,
                  }),
                )
                .catch((e) => setError(String(e)));
            }}
          >
            继续读取过程
          </button>
        )}
      </details>
    </section>
  );
}
