-- Hook v1：精确授权与 Run 快照；事件/执行关联不伪造模型 Step。迁移不运行任何脚本。
CREATE TABLE hook_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY(kind,id)
);
CREATE INDEX hook_records_run ON hook_records(run_id,kind);
CREATE INDEX hook_records_session ON hook_records(session_id,kind);
