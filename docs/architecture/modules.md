# 模块关系与目录

以下工作区已创建，业务模块尚未实现。机器可读允许依赖见 [config/modules.json](../../config/modules.json)。包间通过公开入口导入，不使用跨包相对路径或 `@myagent/foo/src/...`。

| 目录 | 职责 | 允许的内部依赖 | 状态 |
| --- | --- | --- | --- |
| `packages/contracts` | 跨模块数据与协议，不承载业务策略 | 无 | 骨架 |
| `packages/sdk` | Web / CLI 客户端协议封装 | `@myagent/contracts` | 骨架 |
| `packages/kernel` | 唯一 Agent 循环及模型、上下文、工具、权限接口 | `@myagent/contracts` | 骨架 |
| `packages/state` | 会话、任务、运行与调用记录的状态所有权 | `@myagent/contracts` | 骨架 |
| `packages/content` | 记忆、来源材料、检索与版本化产物 | `@myagent/contracts` | 骨架 |
| `packages/application` | 用户用例、命令幂等与事务协调 | `@myagent/contracts`, `@myagent/kernel`, `@myagent/state`, `@myagent/content` | 骨架 |
| `packages/extensions` | 插件清单、作用域注册、Skill 与 Hook 生命周期 | `@myagent/contracts`, `@myagent/kernel` | 骨架 |
| `packages/orchestration` | Workflow、调度、后台工作及子任务协调 | `@myagent/contracts` | 骨架 |
| `packages/observability` | 观测契约、关联字段与脱敏约定 | `@myagent/contracts` | 骨架 |
| `packages/adapters` | 模型、执行、连接器、存储与身份的具体适配层 | `@myagent/contracts`, `@myagent/kernel`, `@myagent/state`, `@myagent/content`, `@myagent/observability` | 骨架 |
| `packages/testing` | 未来的 FakeModel / FakeTool / FakeClock | `@myagent/contracts`, `@myagent/kernel` | 骨架 |
| `apps/web` | Web 工作台入口；当前仅静态工程占位页 | `@myagent/sdk` | 骨架 |
| `apps/server` | 后端唯一装配入口；当前仅启动提示 | `@myagent/application`, `@myagent/kernel`, `@myagent/state`, `@myagent/content`, `@myagent/adapters`, `@myagent/extensions`, `@myagent/orchestration`, `@myagent/observability` | 骨架 |
| `apps/cli` | 通过 SDK 访问应用；当前仅启动提示 | `@myagent/sdk` | 骨架 |
| `apps/worker` | 隔离执行入口；当前仅启动提示 | `@myagent/contracts`, `@myagent/adapters` | 骨架 |

## 工程内的组织方式

- kernel 下 runtime / context / model / tools / policy / interaction / execution / ports 是一个包内的职责目录。
- application 负责用户用例及事务，state 负责状态语义，adapters/storage 负责具体数据库驱动。
- adapters 集中保留模型、执行、连接器、存储、身份、凭证与观测的替换点。
- extensions 定义注册生命周期，plugins 保存将来真正启用的能力包。当前 plugins、skills、workflows 不参与包自动发现。
- orchestration 的 RunCommandPort 最终放在 contracts/commands 中作为中立契约，由 application 实现、server 注入；当前尚未定义该接口。
- testing 只放测试替身，不允许被产品运行代码依赖。
- 包的 public exports 当前只导出空模块；依赖预先连接工作区，不代表业务已经互相调用。

## 依赖规则的检查范围

`pnpm check:architecture` 验证清单与 package.json、内部依赖与导入方向、跨包相对路径、深路径导入、包间循环。contracts / kernel 不允许外部运行时依赖或 Node 内置模块导入。

运行时代码动态产生的导入路径、插件行为、执行端安全隔离仍需未来的契约与集成测试，静态检查不能证明这些能力。

## 其他目录

| 目录 | 用途 |
| --- | --- |
| docs/ | 当前知识、协议、ADR 与迭代记录 |
| config/ | 模块检查清单和运行时配置预留 |
| plugins/、skills/、workflows/ | 扩展和声明式能力预留 |
| tests/、evals/ | 工程 / 功能验证与真实任务评测 |
| migrations/ | 数据与事件格式迁移预留 |
| scripts/ | 工程检查与既有报告生成工具 |
| research/、diagrams/ | 上游证据清单、研究快照和设计交付物 |

完整目标目录原型见 [HTML 报告](../../agent-architecture.html)。当前使用 main.ts / main.tsx 作为入口文件，保留其他职责子目录；这一工程化细化见 [ADR-0002](../adr/0002-workspace-and-tooling.md)。
