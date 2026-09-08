# 稳定运行内核

继承 [根 AGENTS.md](../../AGENTS.md)，本文件补充当前目录规则。

只依赖 contracts 与自己定义的 ports。禁止 Node 内置 API、厂商 SDK、数据库、HTTP 框架和 UI 依赖。运行步骤使用显式调用；观测事件只记录事实。Hook 后重校验；权限不由模型决定。取消、预算、停止原因与恢复语义在功能实现时用真实分支测试。

每轮同步 [当前状态](../../docs/STATUS.md)、相关知识页和 [迭代记录](../../docs/history/README.md)。
