-- 聊天数据库 v1 初始迁移：创建会话、消息、运行、事件和单例设置表。
-- 由 SqliteChatStore 在版本为 0 时通过事务执行；此文件不保存真实密钥。
-- revision 用于命令版本，seq 用于事件排序；创建后分别从 0 开始。
CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
-- 删除会话时级联清理所有答案版本，reply_to_id 关联同一问题的多个候选。
CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, run_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, reply_to_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX messages_session ON messages(session_id);
CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, request_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
-- 同会话同 request_id 只能对应一个 Run；应用层再核对指纹是否一致。
CREATE UNIQUE INDEX runs_request ON runs(session_id, request_id);
-- 部分唯一索引只限制 running，不限制已结束历史；是同会话单运行的数据库兜底。
CREATE UNIQUE INDEX runs_one_active ON runs(session_id) WHERE status = 'running';
-- 事件序号在会话内唯一，内容和事件由仓储在同一事务写入。
CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, seq));
-- 只允许一套活动设置；data 内只含 credentialRef，明文密钥保存在独立文件。
CREATE TABLE settings (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), data TEXT NOT NULL);
