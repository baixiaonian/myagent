# @myagent/contracts

聊天 Session / Message / Run / Settings 与事件 DTO。已实现本地 Agent Loop 对应路径，其余完整 Agent 设计仍为骨架。

公共入口：`src/index.ts`。

遵循 [根开发约定](../../AGENTS.md)、[当前状态](../../docs/STATUS.md) 和 [聊天协议](../../docs/protocols/chat-v1.md)。职责和依赖详见 [模块关系](../../docs/architecture/modules.md)。

Agent 接续入口：[自主循环设计](../../docs/architecture/agent-loop.md)；双协议与工具边界以当前协议和状态文档为准。

当前受控工具实现、目录与边界见 [工具执行系统](../../docs/architecture/tool-execution.md) 和 [执行协议 v3](../../docs/protocols/execution-v3.md)。

项目/MCP v4 已接通：目录选择与默认目录、双作用域文件配置和按项目连接状态，详见 [项目与 MCP](../../docs/architecture/projects-mcp.md) 和 [v4 协议](../../docs/protocols/projects-mcp-v4.md)。

commands.ts 定义命令规则、配置视图、分析及批准绑定 DTO；旧调用缺 command 字段仍表示原资源历史，不能补造授权。

轻量团队 v1 已接通：主 Agent 与成员共用唯一循环，独立历史和持久通信，复用现有权限/恢复；见 [团队架构](../../docs/architecture/teams.md) 和 [v11 协议](../../docs/protocols/teams-v11.md)。
