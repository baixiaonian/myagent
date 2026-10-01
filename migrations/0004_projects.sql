-- 项目管理 v4：创建请求在会话删除后仍保留墓碑，避免网络重试复活已删除会话。
-- MCP 来源及信任资料采用 execution_records 的类型化集合，不保存明文秘密。
CREATE TABLE session_creations (
  request_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  session_id TEXT NOT NULL
);
