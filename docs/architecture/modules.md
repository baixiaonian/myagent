# 模块关系与目录

保留 15 个 workspace，13 个模块实现自主 Agent Loop 和受控工具路径，其余继续作为完整 Agent 的骨架。允许依赖是架构上限，运行时实际调用见源码。机器可读清单：[config/modules.json](../../config/modules.json)。

| 目录 | 职责 | 允许内部依赖 | 状态 |
| --- | --- | --- | --- |
| `packages/contracts` | 聊天 Session / Message / Run / Step / Settings 与事件 DTO | 无 | 工具执行 v1 |
| `packages/sdk` | Web 的 HTTP 命令、SSE 订阅与去重投影 | `@myagent/contracts` | 工具执行 v1 |
| `packages/kernel` | 统一 Agent Loop、ContextBuilder / ModelPort / ToolExecutor | `@myagent/contracts` | 工具执行 v1 |
| `packages/state` | 会话 / Step 仓储、私有续接及凭证契约 | `@myagent/contracts` | 工具执行 v1 |
| `packages/content` | 记忆读取端口、条目校验与有界概览 | `@myagent/contracts` | 记忆 v1 |
| `packages/application` | Agent 用例、上下文桥接、设置快照及运行生命周期 | `@myagent/contracts`, `@myagent/kernel`, `@myagent/state`, `@myagent/content`, `@myagent/extensions`, `@myagent/orchestration`, `@myagent/observability` | 工具执行 v1 |
| `packages/extensions` | Skill 目录与渐进加载、Hook 固定事件与协议；插件管理层已接通 | `@myagent/contracts`, `@myagent/kernel` | Skill / Hook / Plugin v1 |
| `packages/orchestration` | FIFO 模型名额、团队等待环检测 | `@myagent/contracts` | 团队 v1 |
| `packages/observability` | 中立观测端口、区间合并与定点计价 | `@myagent/contracts` | 观测 v1 |
| `packages/adapters` | 双协议模型、SQLite v13、原生执行、MCP 与文件凭证 | `@myagent/contracts`, `@myagent/kernel`, `@myagent/state`, `@myagent/content`, `@myagent/observability`, `@myagent/extensions` | 工具执行 v1 |
| `packages/testing` | 未来的 FakeModel / FakeTool / FakeClock | `@myagent/contracts`, `@myagent/kernel` | 骨架 |
| `apps/web` | 本地聊天工作台、模型设置与响应式界面 | `@myagent/sdk` | 工具执行 v1 |
| `apps/server` | 本地 API / SSE、校验、装配、恢复与静态托管 | `@myagent/application`, `@myagent/kernel`, `@myagent/state`, `@myagent/content`, `@myagent/adapters`, `@myagent/extensions`, `@myagent/orchestration`, `@myagent/observability`, `@myagent/contracts` | 工具执行 v1 |
| `apps/cli` | 通过 SDK 访问应用；当前仅启动提示 | `@myagent/sdk` | 骨架 |
| `apps/worker` | IPC 监督器与沙箱文件/命令入口 | `@myagent/contracts`, `@myagent/adapters` | 工具执行 v1 |

## 定位实现

- Web：`src/App.tsx` 负责会话工作台和交互；`features/chat` 渲染安全 Markdown，`features/settings` 维护设置表单，`components/Modal.tsx` 使用原生对话框。
- SDK：`src/index.ts` 封装所有 HTTP 命令、SSE 自动重连与事件投影；不复制服务端状态机。
- Application：`chat.ts` 管理 Agent 执行、250ms 增量提交和取消；`settings.ts` 维护设置快照、凭证引用和实际连接测试；`tool-selection.ts` 管理 MCP 会话选择的继承、失效核对、预算和事务更新，经 `tools.ts` 组装每次请求的目录。
- Kernel：`context` 提供异步上下文端口与纯预算/配对逻辑，`runtime` 执行模型与工具反馈循环及超时 / 取消，`model` 只定义通用接口。
- State：定义 ChatStore / CredentialStore 契约；Adapters 的 `storage/sqlite` 实现事务，`models/openai` 实现双协议网络，`tools` 实现最小本地执行器，`credentials` 实现原子文件写入。
- Server：`bootstrap` 装配与 HTTP/SSE 路由，`routes/schemas.ts` 集中 JSON 校验，`main.ts` 只处理进程配置与关闭。
- `migrations/0001_chat.sql` / `0002_agent.sql` 是数据库 v1 / v2 迁移；`tests/chat` 包含协议假服务与单元 / 集成测试，`tests/e2e` 是浏览器产品流程。

## 依赖和扩展

`pnpm check:architecture` 检查清单、package.json、跨包相对路径、深路径和循环。contracts / kernel 禁止外部运行时库或 Node API。生产只从包公共入口导入；根 tests 是集成测试组合点，可读各模块源入口。

server 保留对 contracts 的显式依赖，用于路由 DTO 和安全错误类型；Skill 本轮新增 application/adapters → extensions 依赖边。其他允许依赖保留架构设计中的未来方向；其中 testing、CLI 继续是骨架，extensions 已实现 Skill、Hook 与插件清单协议。kernel/tools 提供纯策略、批次端口和调度；application/tools 协调审批/持久事实，adapters/execution 与 adapters/mcp 完成真实适配。

docs 保存有效知识，AGENTS 约束开发，history 追加事实。plugins 包含报告助手示例包，evals 提供创作评测8题与离线评分工具，workflows 仍为预留；仓库 skills/ 仅保留示例说明，产品来源独立配置。research/upstream 只读且排除构建；原始 HTML 和 diagrams 提供设计与实现说明。

本轮新增 StoredStep 私有续接及公开 RunStep，真实调用关系见 [自主循环](agent-loop.md)。工具注册/校验在 adapters，运行中由 Kernel 经端口调用；计划更新仅作为成功结果保存和展示。

## 工具执行新增目录

```text
packages/contracts/src/execution.ts, worker.ts    # 公开执行协议与私有 IPC
packages/kernel/src/tools/                       # Policy、批次、资源锁和 ports
packages/application/src/tools.ts, mcp.ts         # 执行/审批/恢复与连接配置用例
packages/state/src/execution.ts                  # 类型化执行事实仓储
packages/adapters/src/execution/                 # 注册、路径、文件、结果、Worker 网关
packages/adapters/src/mcp/                       # HTTP/stdio/OAuth
packages/adapters/src/storage/sqlite/execution.ts # 同事务事实与事件
apps/worker/src/{main,action}.ts                 # 监督器与沙箱动作入口
apps/server/src/routes/{execution,mcp}.ts        # 严格 HTTP 边界
apps/web/src/features/tools/                     # 工作区、审批、核对和分页界面
migrations/0003_tools.sql                        # v3 增量迁移
 tests/execution/                               # 核心、故障注入、原生、MCP
```

职责、调用顺序、扩展方式见 [工具执行系统](tool-execution.md)。

项目/MCP 管理：application/projects 与 mcp-manager 协调用例；state/projects 定义本机目录和文件端口；adapters/execution/projects 与 mcp/config-files 实现系统交互和原子文件；SDK 和 Web 提供项目选择及独立 MCP 页。详细事实见 [项目与 MCP](projects-mcp.md)。本轮未增加内部依赖边。

命令权限：kernel/tools/commands 提供分析端口与纯规则组合；adapters/execution/command-analysis、command-files、environment 实现 WASM/文件/固定 PATH；application/command-policy 管理版本确认与恢复，ToolService 管理审批和派发前复核。SDK 与独立 Web 设置页消费新增 DTO，Loop 不变，内部依赖边不变。命令配置由 v5 迁移引入，全库当前为 v12，见 [命令协议](../protocols/commands-v5.md)。

ContextService 管理来源、选择与发布；ContextSummarizer 运行无工具摘要任务；context-support 保存内部类型/模板。State ContextStore 定义派生状态与分页历史；Adapters 实现 SQLite v12、根规则文件和实际请求估算。content 提供记忆读取协议和纯选择逻辑，应用层提供实际记忆服务。Web ContextPanel 显示容量、摘要和恢复，不拥有历史状态。详见 [上下文架构](context-management.md)。

kernel/tools/preview 提供共用的纯首尾预览和安全附件投影；FileResultStore 实现受会话约束的原文预览端口，由 Server 注入 ContextService。ToolService 首次反馈和上下文再次缩减使用同一策略；模块依赖边及唯一 Loop 不变。

长期记忆：`application/memory.ts` 与 `memory-jobs.ts` 协调两阶段提炼、版本发布和撤销；`content/memory.ts` 负责纯预算/内容规则，`adapters/memory/files.ts` 负责 Markdown，`storage/sqlite/memory.ts` 保存可重建索引与任务。`server/routes/memory.ts`、SDK 和 `features/settings/MemoryDialog.tsx` 提供独立管理入口。`migrations/0007_memory.sql` 不修改历史或自动触发费用。见 [记忆架构](memory.md)。

Skill：extensions 提供来源/包端口和显式选择，application/skills 协调目录与 Run 激活，adapters/skills 负责 YAML/快照/只读副本。ContextService 注入完整说明，ToolService 在回执事务中发布激活。内部新增 application/adapters → extensions，Kernel 不新增依赖。详见 [Skill 架构](skills.md)。

Hook：extensions/hooks 定义纯协议与文件端口；application/hooks 管理授权、快照与事件，execution-coordinator 与 ToolService 共用锁/槽位；adapters/hooks/files 复用 skills/packages，Worker hook.ts 在沙箱内以 argv 启动固定解释器；SQLite hook_records 保存 v9 记录，SDK/Web 通过独立配置和查询接口读取。依赖边不增加，见 [架构](hooks.md)。

## 插件接入

插件清单/端口在 extensions，PluginService 在 application，Git/包与 SQLite 在 adapters；Skill/MCP/Hook 通过带来源的提供者接入，不改变包依赖边。Kernel、orchestration 和 CLI 不增加插件逻辑。见 [插件架构](plugins.md)。

## 轻量团队

orchestration 提供 FIFO 名额与等待环检测，application/teams 管理持久团队、收件箱及 RunCommandPort；ChatService 继续是唯一运行入口。新增 application → orchestration 依赖。state/adapters 提供 v11 事务，SDK/Web 提供团队过程。Kernel 只有通用输入/完成确认端口，见 [团队架构](teams.md)。

## 可观测性

application → observability 已接通；ObservabilityService 协调 Trace、账本、采集开关、查询和删除匿名化。Kernel 的 ModelPort 只增加中立关联参数。adapters/observability 负责 HTTP 边界、有界文件采集和 OTel；storage/sqlite/observability 保存 v12。Web 观测页通过独立 SDK 查询，聊天 SSE 保持 v6。详见 [观测架构](observability.md)。


Web 观测展示拆分为 `TracePage`（独立路由/树与侧栏）、`use-trace`（分页与轮询）、`trace-view`（纯树/时间坐标）、`trace-presentation`（Step/成员展示投影）、`use-related-traces`（恢复段分页合并）、`TraceInspector`（单页证据/事件）、`ModelCallDetails / CaptureDetails`（选中后读取原始材料与复制），`ObservabilityDialog` 保留任务导航及费用/配置管理。仅消费 SDK；内部依赖边不变。

执行效率修复：registry 根据静态命令/显式只读请求准备受约束执行，gateway 按实际资源生成只读 Worker；ExecutionCoordinator 关联锁持有者并向 ToolService 反馈有界等待，TeamService 经 Server 注入检查后使用原有事件等待。ContextSummarizer 在完整终态后验证弹性预算并记录失败用量。模块依赖与唯一 Loop 不变。


Web 工作台展示层：`SettingsNavigation` 只提供设置页选择，`Modal` 呈现导航/草稿离开提示；业务配置仍由各原设置组件持有。`RunProcess` 以 Run 为单位折叠，`TeamPanel` 在右栏呈现独立成员，`ContextPanel` 只用 ContextView 的冻结容量计算比例。`workspace.css` 统一上述布局，不增加包依赖或执行能力。

文档工作区：contracts/documents 定义目录、正文与 CAS 输入；state/documents 声明文件端口；application/DocumentService 复用执行锁与未知结果隔离；adapters/LocalDocumentFiles 负责项目身份、路径、UTF-8 与原子替换。Server 装配人工操作 API，SDK/Web 提供目录、多标签、Tiptap 单页编辑和隔离 HTML 预览；Web useDocumentSave 管理串行自动保存，SelectedFragments 管理独立选段草稿，发送时沿用消息 content 协议。无内部依赖边变化，详见 [协议](../protocols/documents-v1.md)。
