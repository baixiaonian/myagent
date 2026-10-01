-- 插件 v1：安装/发布记录和 Run 版本引用；升级不导入现有组件、不执行包代码。
CREATE TABLE plugin_records (
 kind TEXT NOT NULL,
 id TEXT NOT NULL,
 session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
 data TEXT NOT NULL,
 PRIMARY KEY(kind,id)
);
CREATE INDEX plugin_records_session ON plugin_records(session_id,kind);
