# 模块关系与目录

保留 15 个 workspace，8 个模块实现聊天 v1 路径，其余继续作为完整 Agent 的骨架。允许依赖是架构上限，运行时实际调用见源码。机器可读清单：[config/modules.json](../../config/modules.json)。

| 目录 | 职责 | 允许内部依赖 | 状态 |
| --- | --- | --- | --- |
| `packages/contracts` | 聊天 Session / Message / Run / Settings 与事件 DTO | 无 | 聊天 v1 |
| `packages/sdk` | Web 的 HTTP 命令、SSE 订阅与去重投影 | `@myagent/contracts` | 聊天 v1 |
| `packages/kernel` | 零工具 Chat Runtime、上下文裁剪与 ModelPort | `@myagent/contracts` | 聊天 v1 |
| `packages/state` | 聊天仓储、凭证契约及状态语义 | `@myagent/contracts` | 聊天 v1 |
| `packages/content` | 记忆、来源材料、检索与版本化产物 | `@myagent/contracts` | 骨架 |
| `packages/application` | 聊天用例、设置快照、幂等提交与运行生命周期 | `@myagent/contracts`, `@myagent/kernel`, `@myagent/state`, `@myagent/content` | 聊天 v1 |
| `packages/extensions` | 插件清单、作用域注册、Skill 与 Hook 生命周期 | `@myagent/contracts`, `@myagent/kernel` | 骨架 |
| `packages/orchestration` | Workflow、调度、后台工作及子任务协调 | `@myagent/contracts` | 骨架 |
| `packages/observability` | 观测契约、关联字段与脱敏约定 | `@myagent/contracts` | 骨架 |
| `packages/adapters` | OpenAI 流式模型、SQLite / Drizzle 与文件凭证 | `@myagent/contracts`, `@myagent/kernel`, `@myagent/state`, `@myagent/content`, `@myagent/observability` | 聊天 v1 |
| `packages/testing` | 未来的 FakeModel / FakeTool / FakeClock | `@myagent/contracts`, `@myagent/kernel` | 骨架 |
| `apps/web` | 本地聊天工作台、模型设置与响应式界面 | `@myagent/sdk` | 聊天 v1 |
| `apps/server` | 本地 API / SSE、校验、装配、恢复与静态托管 | `@myagent/application`, `@myagent/kernel`, `@myagent/state`, `@myagent/content`, `@myagent/adapters`, `@myagent/extensions`, `@myagent/orchestration`, `@myagent/observability`, `@myagent/contracts` | 聊天 v1 |
| `apps/cli` | 通过 SDK 访问应用；当前仅启动提示 | `@myagent/sdk` | 骨架 |
| `apps/worker` | 隔离执行入口；当前仅启动提示 | `@myagent/contracts`, `@myagent/adapters` | 骨架 |

## 定位实现

- Web：`src/App.tsx` 负责会话工作台和交互；`features/chat` 渲染安全 Markdown，`features/settings` 维护设置表单，`components/Modal.tsx` 使用原生对话框。
- SDK：`src/index.ts` 封装所有 HTTP 命令、SSE 自动重连与事件投影；不复制服务端状态机。
- Application：`chat.ts` 管理活动执行、250ms 增量提交和取消；`settings.ts` 维护设置快照、凭证引用和实际连接测试。
- Kernel：`context` 选择最近完整问答，`runtime` 执行一次模型请求及超时 / 取消，`model` 只定义通用接口。
- State：定义 ChatStore / CredentialStore 契约；Adapters 的 `storage/sqlite` 实现事务，`models/openai` 实现网络，`credentials` 实现原子文件写入。
- Server：`bootstrap` 装配与 HTTP/SSE 路由，`routes/schemas.ts` 集中 JSON 校验，`main.ts` 只处理进程配置与关闭。
- `migrations/0001_chat.sql` 是数据库 v1 真正迁移；`tests/chat` 包含协议假服务与单元 / 集成测试，`tests/e2e` 是浏览器产品流程。

## 依赖和扩展

`pnpm check:architecture` 检查清单、package.json、跨包相对路径、深路径和循环。contracts / kernel 禁止外部运行时库或 Node API。生产只从包公共入口导入；根 tests 是集成测试组合点，可读各模块源入口。

本次 server 新增对 contracts 的显式边，用于路由 DTO 和安全错误类型。其他允许依赖保留架构设计中的未来方向；其中 content/extensions/orchestration/observability/testing、CLI、Worker 没有实现新业务。kernel 的 tools/policy/execution 等目录同样是预留，不能视为可用工具系统。

docs 保存有效知识，AGENTS 约束开发，history 追加事实。plugins/skills/workflows/evals 仍预留。research/upstream 只读且排除构建；原始 HTML 和 diagrams 是历史设计产物。
