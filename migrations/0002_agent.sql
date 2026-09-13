-- Agent 数据库 v2：Step 的可见事实和私有续接材料保存在同一记录中。
-- 按 Run 与步骤顺序索引；会话删除经 Run 级联清理，旧消息与旧事件不改写。
CREATE TABLE run_steps (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (run_id, step_index)
);
CREATE INDEX steps_session ON run_steps(session_id, run_id, step_index);
