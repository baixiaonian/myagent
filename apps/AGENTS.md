# 应用入口

继承 [根 AGENTS.md](../AGENTS.md)，本文件补充当前目录规则。

server 是唯一后端装配点；web / cli 仅通过 sdk 和 contracts 访问应用，不能直接调用 kernel 或 adapters。worker 接收受限执行信封，不直接改主会话状态。web / server 已实现本地聊天；CLI 仍为骨架，Worker 已接通真实执行。新增 API 时同步 docs/protocols 与 tests。

应用文件按 [中文注释规范](../docs/development/comments.md) 说明入口职责。Web 特别解释异步竞态、输入法、草稿和滚动规则；Server 特别解释校验、资源装配、SSE 背压和关闭顺序，不能只写文件头而遗漏关键逻辑。

每轮同步 [当前状态](../docs/STATUS.md)、相关知识页和 [迭代记录](../docs/history/README.md)。

项目/MCP 设置是独立管理入口，不创建空会话；目录窗口只能由本机用户 API 触发。
