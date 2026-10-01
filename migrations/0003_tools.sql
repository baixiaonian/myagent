-- 工具执行 v3：增加工作区关联与类型化事实集合；旧 Step JSON 和 v1/v2 事件保持不变。
-- 活动索引包含暂停状态，防止审批或恢复期间同会话又启动第二个 Run。
ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
DROP INDEX runs_one_active;
CREATE UNIQUE INDEX runs_one_active ON runs(session_id)
WHERE status IN ('running','waiting_approval','waiting_reconciliation','recoverable','cleaning');
-- 集合名称由仓储中的固定类型白名单决定，数据中不保存明文凭证。
CREATE TABLE execution_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  PRIMARY KEY(kind,id)
);
CREATE INDEX execution_session ON execution_records(kind,session_id);
CREATE INDEX execution_run ON execution_records(kind,run_id);
