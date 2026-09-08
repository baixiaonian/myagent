# 数据迁移

[0001_chat.sql](0001_chat.sql) 是 SQLite user_version=1 的初始事务迁移，创建 sessions / messages / runs / events / settings、索引及外键。

由 adapters/storage/sqlite 启动时执行；不能手动修改旧迁移来改变已存在数据库。下一次 schema 变更需要新增有序迁移、提升版本并验证升级 / 恢复，更新 [协议](../docs/protocols/chat-v1.md) 和 [维护文档](../docs/development/setup.md)。高于当前支持版本的数据库拒绝打开。
