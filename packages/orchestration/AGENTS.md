# 任务编排

继承 [根 AGENTS.md](../../AGENTS.md)，本文件补充当前目录规则。

固定 WorkflowRunner 与动态 Runtime 分开。只能经 contracts 中立 RunCommandPort 调用应用实现，禁止反向导入 application 或自己另建循环。子任务权限取交集，预算从父级预留；并发、取消、恢复与回执沿用主链路契约。

每轮同步 [当前状态](../../docs/STATUS.md)、相关知识页和 [迭代记录](../../docs/history/README.md)。
