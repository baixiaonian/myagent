/**
 * 执行交互面板：展示审批、未知结果和恢复入口，状态来自服务端，不自行推动工具计划。
 * 轮询只刷新公开执行事实；切换会话后丢弃旧响应，批准和继续均通过 SDK 命令完成。
 */
import type {
  ChatClient,
  ExecutionConcern,
  ExecutionOverview,
  PermissionGrant,
  SessionSnapshot,
  ToolInvocation,
} from "@myagent/sdk";
import { ShieldCheck, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal.js";
import { ResultViewer } from "./ResultViewer.js";

export function ExecutionPanel({
  client,
  snapshot,
  onRefresh,
}: {
  client: ChatClient;
  snapshot: SessionSnapshot;
  onRefresh: () => void;
}) {
  const [data, setData] = useState<ExecutionOverview | null>(null);
  // 每张审批独立保存授权范围，防止上一张的长期选择意外扩散到另一请求。
  const [scopes, setScopes] = useState<
    Record<string, PermissionGrant["scope"]>
  >({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolution, setResolution] = useState<ExecutionConcern | null>(null);
  const [kind, setKind] = useState<
    NonNullable<ToolInvocation["resolution"]>["kind"]
  >("acknowledged_unknown");
  const [note, setNote] = useState("");
  useEffect(() => {
    let disposed = false;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const value = await client.execution(snapshot.session.id);
        if (!disposed) setData(value);
      } catch (error) {
        if (!disposed)
          setNotice(
            error instanceof Error ? error.message : "无法读取执行记录。",
          );
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = snapshot.activeRun?.status
      ? setInterval(() => void refresh(), 1000)
      : undefined;
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, [client, snapshot.session.id, snapshot.activeRun?.status]);
  async function action(operation: () => Promise<unknown>) {
    setBusy(true);
    setNotice("");
    try {
      await operation();
      setData(await client.execution(snapshot.session.id));
      onRefresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  }
  const approvals =
    data?.approvals.filter((item) => item.status === "pending") ?? [];
  const unknown = data?.concerns ?? [];
  const processes =
    data?.processes.filter((process) =>
      data.invocations.some(
        (item) =>
          item.id === process.invocationId && item.toolName === "exec_command",
      ),
    ) ?? [];
  const paused =
    snapshot.activeRun &&
    ["recoverable", "waiting_reconciliation", "waiting_approval"].includes(
      snapshot.activeRun.status,
    );
  if (
    !approvals.length &&
    !unknown.length &&
    !paused &&
    !notice &&
    !processes.length
  )
    return null;
  return (
    <aside className="execution-panel" aria-label="执行操作">
      {notice && <p role="alert">{notice}</p>}
      {processes.length > 0 && (
        <details>
          <summary>命令输出与进程状态 · {processes.length}</summary>
          {processes.map((process) => (
            <section key={process.id}>
              <p>
                命令进程：
                {process.status === "running"
                  ? "运行中"
                  : process.status === "unknown"
                    ? "需要核对"
                    : process.status === "stopped"
                      ? "已停止"
                      : "已退出"}
                ；退出码 {process.exitCode ?? "暂无"}
              </p>
              {process.outputRef && (
                <ResultViewer
                  client={client}
                  sessionId={snapshot.session.id}
                  resultId={process.outputRef}
                />
              )}
            </section>
          ))}
        </details>
      )}
      {approvals.map((approval) => (
        <section className="approval-card" key={approval.id}>
          <header className="approval-heading">
            <ShieldCheck size={18} />
            <div>
              <strong>需要你批准这次操作</strong>
              <span>
                {approval.command ? "运行命令" : approval.toolName} ·
                等待你的决定
              </span>
            </div>
          </header>
          {/* 长命令区必须能被键盘聚焦后滚动，否则无法在批准前读完正文。 */}
          <section
            className="approval-body"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 有界滚动区域需要键盘访问。
            tabIndex={0}
            aria-label="操作与授权范围"
          >
            {approval.command && (
              <div className="command-approval">
                <div className="approval-command-label">
                  <Terminal size={13} />
                  命令
                </div>
                <pre>{approval.command.command}</pre>
                <p>
                  执行目录：<code>{approval.command.cwd}</code>
                </p>
                <ul>
                  {[...new Set(approval.command.reasons)].map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                <p className="field-hint">
                  仅批准本次完整命令。批准交互程序启动后，后续输入不再逐次审批；长期放行请在命令权限中添加规则。
                </p>
              </div>
            )}
            <ul>
              {approval.resources.map((resource) => (
                <li key={`${resource.kind}:${resource.target}`}>
                  <span>
                    {resource.access === "write"
                      ? "读写目录"
                      : resource.access === "read"
                        ? "读取目录"
                        : resource.access === "connect"
                          ? "访问网络"
                          : "调用 MCP 工具"}
                  </span>{" "}
                  <code>{resource.target}</code>
                </li>
              ))}
            </ul>
            <details>
              <summary>查看具体参数</summary>
              <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
            </details>
            {!approval.command && (
              <label>
                授权期限
                <select
                  value={scopes[approval.id] ?? "once"}
                  onChange={(event) =>
                    setScopes((old) => ({
                      ...old,
                      [approval.id]: event.target
                        .value as PermissionGrant["scope"],
                    }))
                  }
                >
                  <option value="once">仅这一次</option>
                  <option value="session">当前会话</option>
                  <option value="workspace">该工作区长期有效，可撤销</option>
                </select>
              </label>
            )}
          </section>
          <div className="inline-actions approval-actions">
            <span>
              {approval.command ? "仅批准本次命令" : "按上方选择的范围授权"}
            </span>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  client.decideApproval(approval.id, {
                    requestId: crypto.randomUUID(),
                    decision: "allow",
                    scope: approval.command
                      ? "once"
                      : (scopes[approval.id] ?? "once"),
                  }),
                )
              }
            >
              批准并继续
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  client.decideApproval(approval.id, {
                    requestId: crypto.randomUUID(),
                    decision: "deny",
                    scope: approval.command
                      ? "once"
                      : (scopes[approval.id] ?? "once"),
                  }),
                )
              }
            >
              拒绝操作
            </button>
          </div>
        </section>
      ))}
      {unknown.map((invocation) => (
        <section className="unknown-card" key={invocation.id}>
          <strong>执行结果需要核对</strong>
          <p>
            {invocation.toolName}{" "}
            可能已经产生修改，但没有获得可靠回执。系统没有自动重做。
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setResolution(invocation);
              setNote("");
            }}
          >
            记录核对结论
          </button>
        </section>
      ))}
      {paused && !approvals.length && !unknown.length && (
        <section>
          <strong>运行已暂停</strong>
          <p>继续会复用已确认的执行结果；尚未完成的模型请求可能重新调用。</p>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() =>
              void action(() => client.resume(snapshot.activeRun?.id ?? ""))
            }
          >
            继续运行
          </button>
        </section>
      )}
      {resolution && (
        <Modal title="记录执行核对结论" onClose={() => setResolution(null)}>
          <p>
            请先检查对应文件或服务。这里记录你的判断，保留原始“结果未知”事实。
          </p>
          <label>
            核对结论
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              <option value="acknowledged_unknown">
                仍无法确认，理解风险后继续
              </option>
              <option value="confirmed_executed">已检查，操作已经发生</option>
              <option value="confirmed_not_executed">
                已检查，操作没有发生
              </option>
            </select>
          </label>
          <label>
            核对说明
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
            />
          </label>
          <button
            type="button"
            className="button primary"
            disabled={busy || !note.trim()}
            onClick={() =>
              void action(async () => {
                await client.resolveInvocation(resolution.id, kind, note);
                setResolution(null);
              })
            }
          >
            保存核对记录
          </button>
        </Modal>
      )}
    </aside>
  );
}
