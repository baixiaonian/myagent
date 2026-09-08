# @myagent/server

本地 API / SSE、校验、装配、恢复与静态托管。已实现本地 Web Chat v1 对应路径，其余完整 Agent 设计仍为骨架。

公共入口：`src/main.ts`；`src/bootstrap/index.ts` 负责装配。

遵循 [根开发约定](../../AGENTS.md)、[当前状态](../../docs/STATUS.md) 和 [聊天协议](../../docs/protocols/chat-v1.md)。职责和依赖详见 [模块关系](../../docs/architecture/modules.md)。
