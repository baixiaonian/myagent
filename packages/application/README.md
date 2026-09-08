# application

用户用例、命令幂等与事务协调。

状态：工程骨架。当前没有对应的 Agent 业务实现。

- 入口：`src/index.ts`。
- 允许的内部依赖：`@myagent/contracts`, `@myagent/kernel`, `@myagent/state`, `@myagent/content`。
- 开发前阅读 [模块关系](../../docs/architecture/modules.md) 和 [当前状态](../../docs/STATUS.md)。
- 新增功能时同时更新上述文档、相关局部 AGENTS.md（规则有变化时）和 [迭代历史](../../docs/history/README.md)。
