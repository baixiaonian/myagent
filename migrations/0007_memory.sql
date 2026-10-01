-- 长期记忆 v7：条目为 Markdown 的可重建投影；来源撤销和任务日志不能随会话外键提前消失。
CREATE TABLE memory_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(kind,id)
);
