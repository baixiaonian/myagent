# 协议目录

- [文档工作区 v1](documents-v1.md)：项目目录、版本保护保存与选段对话。

- [执行权限模式 / SQLite v13](execution-mode-v13.md)

- [可观测性 / SQLite v12 / 独立原始材料接口](observability-v12.md)

- [轻量团队 / SQLite v11 / SSE v6](teams-v11.md)

- [插件管理 / SQLite v10](plugins-v10.md)

- [Hook v1 / SQLite v9 / SSE v5](hooks-v9.md)：四事件、脚本授权、受控执行与恢复。

- [Skill v1 / SQLite v8](skills-v8.md)：目录、激活、完整说明和只读资源。

- [长期记忆 v7](memory-v7.md)：正文、来源、后台任务、删除和持久发布。

当前实现 [本地 Web Chat API v1](chat-v1.md)。类型公共入口为 `packages/contracts/src/index.ts`，客户端封装为 SDK。

工具执行、权限审批、暂停恢复、上下文、记忆和技能已有下列协议。任意插件主进程 SPI、中途指令注入和后台任务编排仍是设计预留；新增能力必须同步版本化文档、迁移和契约测试。

- [工具执行 v3](execution-v3.md)

- [项目与 MCP 管理 v4](projects-mcp-v4.md)：目录选择、默认目录、文件配置、连接状态与迁移。

- [命令权限 v5](commands-v5.md)：规则文件、一次审批、静态检查 API 和数据库迁移。

- [上下文管理与 SQLite v6](context-v6.md)
