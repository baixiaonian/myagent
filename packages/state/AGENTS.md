# 状态服务

继承 [根 AGENTS.md](../../AGENTS.md)，本文件补充当前目录规则。

明确 Session / Task / Run / Invocation 的唯一所有者。状态与关键事件提交保持一致，历史投影不能回放外部动作。涉及 schema 或事件变更时同步迁移、protocols 和恢复测试。数据库驱动放 adapters/storage。

每轮同步 [当前状态](../../docs/STATUS.md)、相关知识页和 [迭代记录](../../docs/history/README.md)。

已定义 ChatStore / CredentialStore 契约。Session revision 用于命令并发，cursor / seq 用于事件重放，二者不可混用。已终结 / 已删除 Run 不接受增量；重新生成的旧答案只有成功后才能 superseded。启动恢复中断不能重新执行模型。
