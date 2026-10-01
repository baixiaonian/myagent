-- 观测 v12：索引化元数据与独立账本；正文文件和历史执行事实不复制到追踪表。
CREATE TABLE observation_records (
  kind TEXT NOT NULL, id TEXT NOT NULL, trace_id TEXT, session_id TEXT, run_id TEXT, call_id TEXT,
  created_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)
);
CREATE INDEX observation_trace ON observation_records(kind,trace_id,created_at);
CREATE INDEX observation_session ON observation_records(kind,session_id,created_at);
CREATE INDEX observation_run ON observation_records(kind,run_id,created_at);
CREATE INDEX observation_call ON observation_records(kind,call_id);
CREATE INDEX observation_model_time ON observation_records(kind,json_extract(data,'$.model'),created_at);
CREATE INDEX observation_purpose_time ON observation_records(kind,json_extract(data,'$.scope.purpose'),created_at);
CREATE INDEX observation_root_time ON observation_records(kind,json_extract(data,'$.scope.rootRunId'),created_at);
CREATE TABLE observation_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
CREATE TABLE observation_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
