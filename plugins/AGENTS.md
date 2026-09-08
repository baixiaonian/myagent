# 插件实现

继承 [根 AGENTS.md](../AGENTS.md)，本文件补充当前目录规则。

当前只是目标目录，尚无启用的插件。新增插件时定义 manifest / API 版本 / 依赖 / 能力范围和资源回收；脚本和外部连接必须走受限能力代理。插件代码不得直接改业务数据库或绕过 Policy。

每轮同步 [当前状态](../docs/STATUS.md)、相关知识页和 [迭代记录](../docs/history/README.md)。
