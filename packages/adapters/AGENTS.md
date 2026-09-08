# 适配器

继承 [根 AGENTS.md](../../AGENTS.md)，本文件补充当前目录规则。

实现上层定义的 ports。厂商差异、数据库驱动、进程与网络细节在此收敛；对外输出通用结果。模型密钥不进入通用消息或日志。Worker 普通子进程不代表安全沙箱。未知写操作结果要通过回执对账。新增依赖仅声明在实际使用的包。

每轮同步 [当前状态](../../docs/STATUS.md)、相关知识页和 [迭代记录](../../docs/history/README.md)。

SQLite user_version 通过 migrations 的事务迁移推进，数据库驱动仅在本层。所有状态修改和对应事件在同一事务提交。凭证独立文件 0600、目录 0700、原子替换，禁止返回明文；不要宣称已加密。OpenAI SDK maxRetries=0，仅发最小 Chat Completions 参数，用本地 HTTP 假服务验证兼容行为。
