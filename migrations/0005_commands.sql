-- 命令权限 v5：命令配置/确认/提交日志使用既有 execution_records 的 commandFiles 类型化集合。
-- 独立版本门禁防止旧程序打开数据库后绕过命令检查；历史资源批准不改写为命令批准。
CREATE INDEX IF NOT EXISTS execution_command_files ON execution_records(kind) WHERE kind = 'commandFiles';
