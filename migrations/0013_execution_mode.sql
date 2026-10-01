-- 完全访问 v13：模式保存于已有 Run JSON，旧记录缺失即标准模式，不回填授权。
-- 版本门禁防止旧程序恢复任务时忽略新模式；索引用于按模式定位执行记录。
CREATE INDEX IF NOT EXISTS runs_execution_mode ON runs(json_extract(data, '$.executionMode'));
