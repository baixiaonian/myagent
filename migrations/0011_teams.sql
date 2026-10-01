-- 轻量团队 v11：内部会话与主对话同生命周期；升级不生成成员、不调用模型。
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
CREATE TABLE team_records (
 kind TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 data TEXT NOT NULL, PRIMARY KEY(kind,id)
);
CREATE INDEX team_records_session ON team_records(session_id,kind);
DROP INDEX runs_one_active;
CREATE UNIQUE INDEX runs_one_active ON runs(session_id)
 WHERE status IN ('running','waiting_agents','waiting_approval','waiting_reconciliation','waiting_context','recoverable','cleaning');

-- 成员任务保留真实来源；role 用于模型传输，origin 用于授权与历史解释。
ALTER TABLE messages ADD COLUMN origin TEXT;
