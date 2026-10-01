# @myagent/server

本地 API / SSE、校验、装配、恢复与静态托管。已实现本地 Agent Loop 对应路径，其余完整 Agent 设计仍为骨架。

公共入口：`src/main.ts`；`src/bootstrap/index.ts` 负责装配。

遵循 [根开发约定](../../AGENTS.md)、[当前状态](../../docs/STATUS.md) 和 [聊天协议](../../docs/protocols/chat-v1.md)。职责和依赖详见 [模块关系](../../docs/architecture/modules.md)。

Agent 接续入口：[自主循环设计](../../docs/architecture/agent-loop.md)；双协议与工具边界以当前协议和状态文档为准。

项目/MCP v4 已接通：目录选择与默认目录、双作用域文件配置和按项目连接状态，详见 [项目与 MCP](../../docs/architecture/projects-mcp.md) 和 [v4 协议](../../docs/protocols/projects-mcp-v4.md)。

上下文接续见 [上下文架构](../../docs/architecture/context-management.md) 和 [v6 协议](../../docs/protocols/context-v6.md)。本轮新增异步准备、来源化摘要、分页历史和容量展示；长期记忆 v1 已接通有界概览、两阶段提炼和按需检索，见 [记忆架构](../../docs/architecture/memory.md)。

轻量团队 v1 已接通：主 Agent 与成员共用唯一循环，独立历史和持久通信，复用现有权限/恢复；见 [团队架构](../../docs/architecture/teams.md) 和 [v11 协议](../../docs/protocols/teams-v11.md)。
