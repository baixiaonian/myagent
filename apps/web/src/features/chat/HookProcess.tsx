/** Hook 过程展示：读取服务端事实，按事件显示状态和日志；不从模型文本推断执行或授权成功。 */
import type { ChatClient, HookExecution } from "@myagent/sdk";
import { useEffect, useState } from "react";
export function HookProcess({
  client,
  sessionId,
  runId,
  cursor,
}: {
  client: ChatClient;
  sessionId: string;
  runId: string;
  cursor: number;
}) {
  const [records, setRecords] = useState<HookExecution[]>([]),
    [log, setLog] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: SSE 游标使刷新与重启后的持久 Hook 状态重新读取。
  useEffect(() => {
    let alive = true;
    void client
      .hooks(sessionId)
      .then((r) => {
        if (alive) setRecords(r.filter((h) => h.runId === runId));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, sessionId, runId, cursor]);
  if (!records.length) return null;
  return (
    <details className="hook-process">
      <summary>Hook · {records.length} 次</summary>
      {records.map((r) => (
        <div key={r.id}>
          <strong>
            {r.event} · {r.hookId}
          </strong>{" "}
          <span>
            {
              {
                prepared: "等待执行",
                running: "执行中",
                succeeded: "已完成",
                failed: "失败",
                denied: "已拒绝",
                cancelled: "已取消",
                unknown: "待核对",
              }[r.status]
            }
          </span>
          {r.error && <p>{r.error.message}</p>}
          {r.output?.reason && <p>{r.output.reason}</p>}
          {r.resultRef && (
            <button
              type="button"
              className="button"
              onClick={() =>
                void client
                  .result(sessionId, r.logRef ?? r.resultRef!)
                  .then((v) => setLog(v.text))
                  .catch((e) => setLog(String(e)))
              }
            >
              查看日志
            </button>
          )}
        </div>
      ))}
      {log && <pre>{log}</pre>}
    </details>
  );
}
