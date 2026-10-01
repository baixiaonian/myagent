-- Skill v8：目录管理、Run 选择与可恢复包引用；不迁入外部技能、不执行模型或脚本。
CREATE TABLE skill_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(kind,id)
);
