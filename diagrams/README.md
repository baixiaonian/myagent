# 架构图资产

本目录保存 MyAgent 的原理与实现图；已有 HTML/工具权限图保持原用途。

## 七种多 Agent 协作模式

- [HTML 七图图集](multi-agent-patterns/index.html)：内嵌 SVG，可离线阅读；提供全部图与 Teams / 群聊对比入口。
- [生成入口](gen-multi-agent-patterns.mjs)、[共用部件](parts-multi-agent-patterns.mjs)、[图集模板](multi-agent-gallery.mjs)：运行 `node diagrams/gen-multi-agent-patterns.mjs` 重建；使用本机 Excalidraw 绘图技能，不属于产品运行依赖。
- [图形清单](multi-agent-patterns/manifest.json)：记录七个文件基名、524 个可编辑元素的逐图数量及上游来源。严格 JSON 不包含注释。

| 图 | 矢量交付 | 可编辑图源 |
| --- | --- | --- |
| 1. 主 Agent 委派子任务 | [SVG](multi-agent-patterns/01-delegation.svg) | [Excalidraw](multi-agent-patterns/01-delegation.excalidraw) |
| 2. 持续子会话协作 | [SVG](multi-agent-patterns/02-continuable.svg) | [Excalidraw](multi-agent-patterns/02-continuable.excalidraw) |
| 3. 团队任务板 | [SVG](multi-agent-patterns/03-teams.svg) | [Excalidraw](multi-agent-patterns/03-teams.excalidraw) |
| 4. 控制权交接 | [SVG](multi-agent-patterns/04-handoff.svg) | [Excalidraw](multi-agent-patterns/04-handoff.excalidraw) |
| 5. 图编排 | [SVG](multi-agent-patterns/05-workflow.svg) | [Excalidraw](multi-agent-patterns/05-workflow.excalidraw) |
| 6. 轮流群聊 | [SVG](multi-agent-patterns/06-group-chat.svg) | [Excalidraw](multi-agent-patterns/06-group-chat.excalidraw) |
| 7. 外部运行时委派 | [SVG](multi-agent-patterns/07-external-runtime.svg) | [Excalidraw](multi-agent-patterns/07-external-runtime.excalidraw) |

这是上游机制研究，不代表 MyAgent 已实现多 Agent。前六项描述协作方式，第七项是可组合的接入方式；图集各卡片保留公开来源。第三项专指任务板与独立 Loop，第六项专指轮流广播，不能把所有名为 Team 的框架都归入第三项。PNG 仅为布局自审中间文件，交付使用 SVG；Excalidraw 文件可在 IDE 或 excalidraw.com 继续编辑。

## Hook 报告路径检查示例

- [hooks-report-example.png](hooks-report-example.png)：可直接查看的图片，展示配置确认、拒绝反馈和重新检查。
- [hooks-report-example.svg](hooks-report-example.svg)：同布局矢量图。
- [hooks-report-example.drawio](hooks-report-example.drawio)：66 个可编辑图形元素。
- [gen-hooks-report-example.py](gen-hooks-report-example.py)：唯一布局来源，运行 `python3 diagrams/gen-hooks-report-example.py` 重建三种格式；依赖 Pillow 和中文字体，可通过 `--font` 指定字体。产品构建不依赖绘图环境。

示例匹配 `PreToolUse` 和 `write_file`，要求目标位于 `reports/`。第一次请求被拒绝，原因交给模型；图中展示模型选择调整路径后再次请求的分支，不保证模型一定重试，也不是 Hook 自动改写参数。`continue` 仅结束 Hook 检查，业务工具仍需原有权限和沙箱。

此图为机制示意，不是某次真实任务的运行证据，不安装或启用该示例。检查范围只覆盖指定工具，不把路径字符串检查当作所有写入方式的安全隔离。

| 图中责任 | 当前实现入口 |
| --- | --- |
| 配置、确认、Run 快照及事件触发 | [HookService](../packages/application/src/hooks.ts) |
| 配置文件、脚本包和解释器身份 | [LocalHookFiles](../packages/adapters/src/hooks/files.ts) |
| 写入前检查与拒绝反馈 | [ToolService](../packages/application/src/tools.ts) |
| 标准输入、标准输出与标准错误协议 | [公开契约](../packages/contracts/src/hooks.ts)、[协议校验](../packages/extensions/src/hooks.ts)、[Worker](../apps/worker/src/hook.ts) |
| 配置和记录 HTTP 接口 | [路由](../apps/server/src/routes/hooks.ts) |

四个事件与故障策略见 [Hook 协议](../docs/protocols/hooks-v9.md)，配置使用见 [维护说明](../docs/development/hooks.md)。

## Skill 实现原理图

- [skills.svg](skills.svg)：单画布展示目录、完整说明、资源三层加载及工具反馈回路。
- [skills.excalidraw](skills.excalidraw)：111 个可编辑元素，可在 Excalidraw 调整。
- [gen-skills.mjs](gen-skills.mjs)：唯一图源，运行 `node diagrams/gen-skills.mjs` 重建；使用下文同一本机绘图技能，产品不依赖它。
- skills.png：离线布局自审中间产物，交付使用 SVG。

蓝色为目录与模型输入，紫色为激活正文和包快照，绿色为工具观察进入下一次请求，橙色为原有执行治理。目录在 Run 开始冻结；用户明确选择在首请求前加载，模型自主加载后在下一次请求获得完整说明。图中 report/review 是示意名称，不是自动安装的内置技能。目录有预算限制，超出部分仍能 search_skills；技能正文独立注入且不会被聊天摘要替换，必要输入超限沿用 waiting_context。

| 图中责任 | 当前实现入口 |
| --- | --- |
| 文件发现、元信息解析、包捕获与只读副本 | [LocalSkillFiles](../packages/adapters/src/skills/files.ts) |
| Run 目录、选择、激活、搜索和恢复 | [SkillService](../packages/application/src/skills.ts) |
| 完整说明单独注入和容量统计 | [ContextService](../packages/application/src/context-service.ts) |
| 加载回执与激活同事务 | [ToolService](../packages/application/src/tools.ts)、[Server 装配](../apps/server/src/bootstrap/index.ts) |
| 技能普通工具和原有执行资源准备 | [注册表](../packages/adapters/src/execution/registry.ts) |
| 脚本资源边界、只读包不可写 | [执行网关](../packages/adapters/src/execution/gateway.ts)、[Worker](../packages/adapters/src/execution/worker-runtime.ts) |
| 激活记录与包引用持久保存 | [SQLite Skill 仓储](../packages/adapters/src/storage/sqlite/skills.ts) |

截图之外的包容量、取消、恢复和迁移边界见 [Skill 架构](../docs/architecture/skills.md)；没有增加新的 Agent Loop 或赋予技能独立执行权限。

## 上下文管理原理图

- `context-management.svg`：当前交付矢量图，以卡片数量、颜色和引用编号展示压缩与查阅。
- `context-management.excalidraw`：117 个可编辑元素，能用 Excalidraw 打开。
- `gen-context-management.mjs`：唯一图源；使用自由绘制画布生成卡片、摘要漏斗和查阅回路。
- `context-management.png`：离线布局检查产物，不作为精确字体基准。

同编号代表同一来源：左侧 #01–04 原文保留，中间只放一张摘要；#05–06 直接选入。模型需要细节时，查回 #03 的片段放进下一次请求。图中序号是示意，不代表固定保留轮数；本轮已完成步骤同样可摘要。详细预算、事务、恢复和协议放在 [架构正文](../docs/architecture/context-management.md)，不堆入插画。

从仓库根目录运行：

```sh
node diagrams/gen-context-management.mjs
```

生成器引用本机 `jemicy-zjm-excalidraw-diagram` 的 `render/freedraw.mjs`；其他机器需把 import 改为已安装技能的绝对路径。产品构建不依赖图表技能。修改图源后重新生成并检查 PNG，不能只手改导出 SVG；原 DSL 已由该生成器取代。

## 对照当前实现

| 图中责任 | 源码入口 |
| --- | --- |
| 组装输入、预览、摘要复用与事务发布 | [ContextService](../packages/application/src/context-service.ts) |
| 分块、无工具摘要请求、取消与候选校验 | [ContextSummarizer](../packages/application/src/context-summarizer.ts)、[摘要模板](../packages/application/src/context-support.ts) |
| 输入估算、阈值与完整调用配对 | [预算与分块](../packages/kernel/src/context/budget.ts) |
| 默认 200k 容量 | [公开容量契约](../packages/contracts/src/context.ts) |
| 持久记录、摘要和历史白名单投影 | [上下文 SQLite](../packages/adapters/src/storage/sqlite/context.ts)、[消息仓储](../packages/adapters/src/storage/sqlite/store.ts) |
| 工具结果保存与容量边界 | [结果文件库](../packages/adapters/src/execution/results.ts)、[执行契约](../packages/contracts/src/execution.ts) |
| 历史工具和结果分页装配 | [Server](../apps/server/src/bootstrap/index.ts) |
| 循环的可取消上下文等待 | [Agent Loop](../packages/kernel/src/runtime/index.ts) |

图中的“原始历史”指本地已采集的事实，不承诺超过额度仍无限完整。模型查询可以读取已保存内容；未采集的部分无法通过查询找回。长期记忆已接通下方的两阶段整理与渐进查阅；会话摘要不等于跨会话记忆，两者都不能用于授予执行权限。

## 大工具结果处理原理图

- [tool-result-handling.svg](tool-result-handling.svg)：交付矢量图，用蓝色开头、紫色结尾和绿色补读回路表示数据去向。
- [tool-result-handling.excalidraw](tool-result-handling.excalidraw)：87 个可编辑元素；引用 #R17 和退出码是示例，不对应真实任务。
- [gen-tool-result-handling.mjs](gen-tool-result-handling.mjs)：唯一图源，运行 `node diagrams/gen-tool-result-handling.mjs` 重建。使用同一 Excalidraw 技能，无新增产品依赖。
- tool-result-handling.png：布局自审中间产物；最终交付 SVG。

原文件中间段仍保存在本地，模型先看到头尾预览，需要细节时用 read_tool_result 分页补读；返回的是所需片段，不是重新塞入整份结果。预览预算包含执行事实、说明和引用；已采集原文与采集是否完整分开表述。命令即时日志 6000 字符、普通结果预览默认 8000 字符，保存仍受单结果 20 MiB / 单 Run 100 MiB 限制。

| 图中内容 | 实现入口 |
| --- | --- |
| 采集原文保存、结果引用与分页 | [FileResultStore](../packages/adapters/src/execution/results.ts) |
| 首尾分配、JSON 长度预算与执行事实 | [preview.ts](../packages/kernel/src/tools/preview.ts) |
| 工具回执持久化及模型反馈 | [ToolService](../packages/application/src/tools.ts) |
| 上下文再次缩减从原文件重建 | [ContextService](../packages/application/src/context-service.ts) |
| 命令日志预览及游标分页 | [Worker](../packages/adapters/src/execution/worker-runtime.ts) |

详细规则见 [工具执行架构](../docs/architecture/tool-execution.md) 和 [首尾预览迭代](../docs/history/2026-09-26-tool-result-preview.md)。

## 长期记忆实现原理图

- [long-term-memory.svg](long-term-memory.svg)：当前交付矢量图，按后台整理、分层保存、新对话复用三层展示。
- [long-term-memory.excalidraw](long-term-memory.excalidraw)：126 个可编辑元素，可在 Excalidraw 调整。
- [gen-long-term-memory.mjs](gen-long-term-memory.mjs)：唯一图源，运行 `node diagrams/gen-long-term-memory.mjs` 重建；复用本机技能，无新增产品依赖。
- long-term-memory.png：仅供布局自审；交付使用 SVG。

蓝色表示概览进入模型请求，绿色双向链路表示模型按需搜索和读取片段，紫色表示已有知识参与整理或用户明确修改。会话片段为绘图示例，不是运行数据；两阶段可分块，不代表固定两次模型调用。原始记录只读提炼，记忆库的正文、精简概览、来源产物与 SQLite 状态各有职责；没有新增独立会话笔记。

| 图中责任 | 当前实现入口 |
| --- | --- |
| 空闲候选、单会话提炼与跨会话合并 | [MemoryJobs](../packages/application/src/memory-jobs.ts) |
| 发布复核、人工修订、遗忘与来源撤销 | [MemoryService](../packages/application/src/memory.ts) |
| 全局偏好、当前项目、其他导航的预算选择 | [纯内容选择](../packages/content/src/memory.ts) |
| Run 首次概览快照、后续复用及撤销 | [ContextService](../packages/application/src/context-service.ts) |
| Markdown 正文与派生产物 | [LocalMemoryFiles](../packages/adapters/src/memory/files.ts) |
| 任务、版本、来源与可重建索引 | [SqliteMemoryStore](../packages/adapters/src/storage/sqlite/memory.ts) |
| 搜索、查阅、明确更新工具 | [工具注册](../packages/adapters/src/execution/registry.ts)、[Server 装配](../apps/server/src/bootstrap/index.ts) |

图中空闲 30 分钟是默认自动条件，页面可以手动整理历史。概览取一次 Run 快照后复用，删除/禁用在下一准备边界撤销；普通更新下一 Run 生效。任务队列、费用额度、文件冲突和恢复细节留在 [记忆架构](../docs/architecture/memory.md) 与 [v7 协议](../docs/protocols/memory-v7.md)。

## 插件从配置到生效

- [plugin-activation.png](plugin-activation.png)：当前实现的完整配置生效链路。
- [SVG](plugin-activation.svg) · [可编辑 Draw.io](plugin-activation.drawio) · [生成器](gen-plugin-activation.py)。
- 使用安装了 Pillow 的 Python 运行 `python diagrams/gen-plugin-activation.py` 重建，布局同时生成三种格式；产品构建不依赖绘图运行时。

图按“包声明/管理设置 → 候选预览 → 用户确认 → 包与数据库登记 → Run 冻结 → 三类组件接入”展开。`PluginService.confirm` 发布，`ChatService` 在创建 Run 的事务中调用 `PluginService.initialize`；Server 将同一版本集合接到 SkillService、MCP Runtime 和 HookService。源码对应继续见下方插件支持表。

图中红色分支为当前真实边界：仅实现 MyAgent 原生 Hook，外部 Codex/Claude Hook 尚未接入兼容适配器。MCP 启用后可以先握手发现工具，图中位于 Run 下方表示任务使用冻结的连接/工具目录，不表示握手必须等模型请求。图不代表组合插件已经完成真实验收，执行证据见 [公开组合插件检查](../docs/history/2026-10-01-public-plugin-composite-check.md)。

## 插件支持链路与原理

- [plugins.png](plugins.png)：高清图，按安装、生效、接入与版本更替展示。
- [plugins.svg](plugins.svg)：矢量图；[plugins.drawio](plugins.drawio)：可编辑源文件。
- [gen-plugins.py](gen-plugins.py)：共享布局图源。用安装了 Pillow 的 Python 执行 `python diagrams/gen-plugins.py`，可用 `--font` 指定中文字体；不加入产品依赖。

蓝色为说明/模型请求，绿色为工具定义与结果反馈，橙色虚线为应用层生命周期触发，紫色为版本管理。图中标明 PluginService 发布、SkillService → ContextService、MCP Runtime 与 HookService 的实际接入点；Skill 进入上下文，MCP 提供工具定义，Hook 由固定节点触发。标准模式的本地动作使用沙箱，Hook 独立授权；完全访问遵循已选择的执行模式，本地沙箱不约束远端服务内部。图只表示插件职责与关键约束，不表示全部调用都一定触发审批或 Hook。

| 图中责任 | 当前实现入口 |
| --- | --- |
| 包清单与兼容报告 | [extensions/plugins](../packages/extensions/src/plugins.ts) |
| 本地/Git 候选与不可变包 | [LocalPluginFiles](../packages/adapters/src/plugins/files.ts) |
| 确认、作用域、Run 引用、回收 | [PluginService](../packages/application/src/plugins.ts) |
| Run 版本集合与组件装配 | [ChatService](../packages/application/src/chat.ts)、[Server](../apps/server/src/bootstrap/index.ts) |
| 能力提供者 | [SkillService](../packages/application/src/skills.ts)、[MCP Runtime](../packages/adapters/src/mcp/runtime.ts)、[HookService](../packages/application/src/hooks.ts) |

协议与操作见 [插件 v10](../docs/protocols/plugins-v10.md) 和 [使用维护](../docs/development/plugins.md)。

## 轻量多 Agent 实现图

- [agent-teams.svg](agent-teams.svg)：交付矢量图。蓝色为主 Agent 创建，紫色为双向通信，橙色为收拢后交付；两位成员的角色只是示例。
- [agent-teams.excalidraw](agent-teams.excalidraw)：132 个可编辑元素，可在 Excalidraw 中继续修改。
- [gen-agent-teams.mjs](gen-agent-teams.mjs)：唯一图源；在仓库根运行 `node diagrams/gen-agent-teams.mjs` 重建。引用本机 Excalidraw 技能，产品构建不依赖该工具。
- agent-teams.png：离线布局自审用，交付以 SVG 为准。

图中的创建是身份、内部会话和运行状态的创建，不是克隆 OS 进程。成员复用一个 runAgent 实现，各自准备上下文、执行模型和工具。消息通过服务端持久收件箱直达接收者；已入队不表示模型已阅读，完成批次后的检查点与下一请求才确认投递。底部本地沙箱链路仅指文件/命令，不代表沙箱能限制远端 MCP 服务内部。

| 图中链路 | 当前源码 |
| --- | --- |
| 创建意图、事务回执、异步成员启动 | [TeamService](../packages/application/src/teams.ts)、[ChatService](../packages/application/src/chat.ts) |
| 六个普通协作工具、最终参数校验 | [工具定义](../packages/adapters/src/execution/team-tools.ts)、[ToolService](../packages/application/src/tools.ts) |
| 收件箱、安全边界和完成确认 | [TeamService](../packages/application/src/teams.ts)、[唯一循环](../packages/kernel/src/runtime/index.ts) |
| 消息身份、运行端口和持久记录 | [contracts](../packages/contracts/src/teams.ts)、[state](../packages/state/src/teams.ts)、[SQLite](../packages/adapters/src/storage/sqlite/teams.ts) |
| 模型公平队列和等待环 | [orchestration](../packages/orchestration/src/index.ts) |
| 成员状态、通信和过程 | [TeamPanel](../apps/web/src/features/chat/TeamPanel.tsx) |

详细边界见 [团队架构](../docs/architecture/teams.md)、[v11 协议](../docs/protocols/teams-v11.md)。

## 多 Agent 工具、启动与通信展开图

- [agent-teams-tool-flow.svg](agent-teams-tool-flow.svg)：按模型、后端与接收方展开创建和通信，并列出主/成员工具差异。用于回答“spawn_agent 是谁的工具、哪里真正启动、如何发送/接收”。
- [agent-teams-tool-flow.excalidraw](agent-teams-tool-flow.excalidraw)：136 个可编辑元素。
- [gen-agent-teams-tool-flow.mjs](gen-agent-teams-tool-flow.mjs)：唯一图源；运行 `node diagrams/gen-agent-teams-tool-flow.mjs` 重建，复用同一本机 Excalidraw 技能。PNG 仅供布局自审。

图中实线为调用/投递，虚线为工具结果与回复。ToolService/TeamService/ChatService 是程序模块，不是模型工具或其他 Agent；成员创建不会克隆 OS 进程。主 Agent 使用 spawn_agent 后，维护器通过中立 startMember 端口调用 ChatService.start，创建成员 Run 并复用 runAgent。双方发送消息使用 send_message，接收方通过通用安全边界自动读取，不要求调用收信工具。

工具限制核对 [TeamService.allowed](../packages/application/src/teams.ts)、[ToolService](../packages/application/src/tools.ts)、[Server 装配](../apps/server/src/bootstrap/index.ts)、[协作工具定义](../packages/adapters/src/execution/team-tools.ts)。成员排除 spawn_agent、stop_agent、update_memory；read_agent_history 限制自身及显式共享。实际工具目录仍受项目、配置和各自 MCP 按需加载状态影响。

通信展开图保留三类消息设计：request 要求接收方处理，能启动空闲成员的新 Run；inform 是 Agent 的信息/回复，不启动空闲成员；result 是程序依据真实状态生成的运行回执，发给主 Agent 与对应请求方，不由模型通过 send_message 发送。三者都保存至收件箱。处于 waiting_agents 的运行可因收到消息继续，不能把该等待状态等同于任务已结束后的空闲成员。
