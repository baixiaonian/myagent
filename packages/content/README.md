# content

长期记忆的纯内容协议、校验、脱敏和预算选择。已接通跨会话 MemoryProvider；无文件/数据库/模型驱动。

- `src/index.ts`：MemorySnippet、MemoryProvider，空提供方保留供独立测试。
- `src/memory.ts`：条目校验、完整条目概览选择、已知秘密形态脱敏。
- 模型整理在 application，Markdown/SQLite 在 adapters。允许依赖仅 `@myagent/contracts`。

入口：[记忆架构](../../docs/architecture/memory.md)、[记忆协议](../../docs/protocols/memory-v7.md)、[当前状态](../../docs/STATUS.md)。向量数据库、自动 Skill、知识库不在本轮范围。
