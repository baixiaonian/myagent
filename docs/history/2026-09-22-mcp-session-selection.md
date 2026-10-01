# 2026-09-22：同会话复用已加载 MCP 工具

## 目的与范围

用户继续追问时复用已发现且仍有效的 MCP 按需定义；应用重启后也能恢复。沿用每服务 deferred/direct 配置、权限与 Loop，不共享其他会话选择，不自动执行工具。

## 模块与协议

- application 新增 McpToolSelection，管理版本引用、有效性核对、预算淘汰和事务保存；ChatService 新 Run 原子继承，ToolService 负责快照与搜索更新。
- state 增加 sessionTools 集合和检查点 loadedToolBindings；旧 loadedTools 为兼容投影，缺版本不猜测迁移。SQLite v4 通用 JSON/外键可直接存储，无 DDL、API 或事件变化。
- Web MCP 表单说明更新为同会话复用；中文注释与知识文档同步。根、application、state AGENTS 增加约束，adapters/Web/tests/docs 等局部约定已检查，无需新增规则。
- 模块依赖没有变化，config/modules.json 不需要改动。内容、编排、扩展等骨架保持原范围。

## 验证

专项 19 项通过（新建选择测试 12 项，原提供方式测试 7 项），日志 `.cache/mcp-selection-focused.log`。双协议实际 loopback HTTP 验证：首轮搜索/调用/回答 3 次模型请求；关闭重建应用后，追问调用/回答 2 次，首次请求即含有效定义，而且仍须新的业务执行审批。覆盖独立会话/项目、配置权限变化、断连/同版本重连、定义更新、预算淘汰、旧检查点、事务回滚、终态迟到结果与删除清理。

- `pnpm verify` 通过：127 项通过，5 项原生专项按既有规则跳过；格式、类型、模块边界、文档、生产构建及凭证产物检查通过。日志 `.cache/mcp-selection-verify.log`。
- `pnpm test:e2e` 12 条通过：增加刷新后追问断言，执行过程只有一次 MCP 业务调用，没有 search_tools；保留重新运行、审批、未知结果核对和授权撤销回归。日志 `.cache/mcp-selection-e2e.log`。
- `git diff --check` 通过。原有两处 CSS 优先级提示及前端大包提示仍在，本轮未修改样式或打包策略。

## 边界与接续

本轮使用临时数据与本地模型/MCP 协议替身，不新增真实模型、生产 MCP、Docker 或原生隔离验收。不修改用户配置，不提交推送。缓存省去搜索动作，但每次模型请求仍携带完整有效定义并计入上下文预算。

入口：packages/application/src/tool-selection.ts、tools.ts、chat.ts；协议见 [v4](../protocols/projects-mcp-v4.md)，原因见 [ADR 0008](../adr/0008-session-tool-selection.md)。
