# 应用入口

继承 [根 AGENTS.md](../AGENTS.md)，本文件补充当前目录规则。

server 是唯一后端装配点；web / cli 仅通过 sdk 和 contracts 访问应用，不能直接调用 kernel 或 adapters。worker 接收受限执行信封，不直接改主会话状态。web / server 已实现本地聊天；CLI / worker 仍为骨架。新增 API 时同步 docs/protocols 与 tests。

每轮同步 [当前状态](../docs/STATUS.md)、相关知识页和 [迭代记录](../docs/history/README.md)。
