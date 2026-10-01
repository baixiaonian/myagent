-- 上下文 v6：摘要和请求清单是派生资料，原消息、步骤、结果文件保持原样。
-- 暂停整理仍占用会话唯一活动 Run，旧程序通过 user_version 门禁拒绝打开。
DROP INDEX runs_one_active;
CREATE UNIQUE INDEX runs_one_active ON runs(session_id)
WHERE status IN ('running','waiting_approval','waiting_reconciliation','waiting_context','recoverable','cleaning');
CREATE TABLE context_records (
  kind TEXT NOT NULL, id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  data TEXT NOT NULL, PRIMARY KEY(kind,id)
);
CREATE INDEX context_session ON context_records(kind,session_id);
CREATE INDEX context_run ON context_records(kind,run_id);
