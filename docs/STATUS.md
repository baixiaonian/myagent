# 当前状态

完成[本轮提交前集成验证](history/2026-10-02-integration-git-delivery.md)：工程测试388项通过、原生专项22项通过、浏览器48项通过，创作评测82份冻结材料及10项离线工具回归通过。浏览器首轮测试服务启动超时，未修改代码的重跑通过；原日志保留。原始评测数据明确排除Git，完整实现、配套测试与知识作为集成基线交付，未新增真实模型调用。

已发布[MyAgent × dsh 创作评测在线报告](https://myagent-dsh-creative-evaluation.witbaixinlei.chatgpt.site)：8题逐项展示任务描述、评分标准及权重、两边评分、token、耗时、请求数与缓存比例；支持累计消耗/最终交付轮切换、16份原始作品在线阅读和下载。新站点保持仅本人登录可访问；不发布原始模型调试材料。浏览器验证与发布证据见[本轮记录](history/2026-10-01-creative-evaluation-online-report.md)。本轮无新增模型请求，原有评测记录继续保留。

完成[创作评测补测与完整交付](history/2026-10-01-creative-comparison-completion.md)：MyAgent与dsh同用deepseek-flash，现均交付8/8份作品；质量通过4/8与5/8，8题均分81.41与83.44。独立补测将单次请求上限提高到900秒；dsh图解另因32768输出额度不足，以65536再测完成。原始失败全部保留，不将不同条件的补测当成一次成功率实验；四份新增HTML已实际浏览器验收并记录真实缺陷。不修改用户模型配置或产品代码，未提交推送。首次结果见[首轮记录](history/2026-10-01-creative-comparison.md)。

新增[插件从配置到生效图](../diagrams/plugin-activation.png)：展示包声明、管理确认、发布、Run 冻结以及 Skill/MCP/Hook 的三个接入位置；明确标注外部 Hook 适配器尚未实现。仅增加图表与文档，不改变运行配置，见[图表记录](history/2026-10-01-plugin-activation-diagram.md)。

公开组合插件补查：`sqlew-io/sqlew-plugin` 5.3.2 的真实 Git 安装预览识别 3 个 Skill 和 1 个 MCP，外部 Hook 协议被阻断；未排除 Hook、未确认安装或启动组件，不能记为组合插件验收通过。详情见[兼容缺口记录](history/2026-10-01-public-plugin-composite-check.md)。

修复右侧 HTML 仅显示占位符：默认交互预览运行自包含页面的内嵌脚本，文字编辑保留静态选区与原文保存。双层 sandbox/CSP 隔离宿主、网络和自身导航，运行态不写回；见[原因、验证与边界](history/2026-10-01-html-interactive-preview.md)。本轮 verify 388 项、端到端 48 项通过，实际报表右栏总计和四个月筛选已核对，本地 3000 已更新；不修改模型、插件或报表文件。

公开插件实测：从 `openai/plugins` 安装并保留 Build Web Data Visualization 0.1.21，18 个 Skill 无兼容阻断或排除，作用域为独立验收项目。当前真实 Chat Completions 连接完成报表生成和窄屏修复；浏览器核对收入/订单、四个月份筛选以及 390/320px 布局通过。首轮请求超时、路径误用及键盘自动化未确认项均保留，未将其记为全通过；见[本轮证据和范围](history/2026-10-01-public-plugin-live.md)。未修改产品代码或模型设置，插件保持启用。

更新[插件实现总图](../diagrams/plugins.png)，明确 PluginService 安装发布、三类组件接入位置、Run 版本冻结和引用释放后清理；标明标准模式本地沙箱与 Hook 独立授权边界。只修改图源与文档；Draw.io 87 个 cell 校验和图片目视检查通过，详见[图表更新记录](history/2026-10-01-plugin-support-diagram.md)。

文档工作区已调整为单页实时 Markdown 编辑，移除模式切换、手动保存按钮和重复文件路径行；保存状态与刷新入口合并到标签栏右侧（见[紧凑布局记录](history/2026-09-30-document-compact-header.md)）；选区浮层仅保留添加到对话（见[移除编辑入口记录](history/2026-09-30-document-remove-selection-edit.md)），输入区使用可展开移除的片段芯片。自动保存按文件串行并保护 IME、版本冲突和迟到刷新；切换项目或收起不丢修改。此前全量 verify 388 项工程测试、浏览器 47 项通过；本次移除入口后构建与文档浏览器 9 项回归通过；本地 3000 已更新，10 个会话、模型设置和原文章保持不变。入口见 [本轮记录](history/2026-09-30-document-inline-editing.md)。SQLite v13 与 SSE 不变。

最新界面：整轮执行记录在完成后收起，团队在右侧独立展示，审批紧邻输入区；输入栏常驻完整上下文窗口占比，Skill/MCP 与其他配置共用设置导航、搜索和草稿保护。容量来自该 Run 冻结值；SQLite 仍 v13、SSE 不变。见 [审查、改动和验证记录](history/2026-09-30-workbench-design.md)。最终 verify 384 项、完整浏览器 38 项通过；本地 3000 已更新，9 个会话与配置保持不变，模型请求仍为 529。

新增[创作评测8题包](../evals/creative-v1/README.md)：覆盖文章、材料梳理、长文、源码导读及三类HTML作品。材料/裁判分离，离线工具10项回归通过；作品质量仍需实际运行与独立评分，不将资料检查视为Agent通过。见[本轮记录](history/2026-09-29-creative-eval-suite.md)。

最新改造：Trace 按 Agent / Step 展示，正常权限检查收进诊断；同任务恢复段合并查看，右侧同页显示来源变化、属性、事件、Link 和实际模型输入输出，支持完整已保存原文复制。新增上下文准备前的观测边界与安全证据接口，旧未采数据不补造。见 [本轮记录](history/2026-09-29-trace-step-details.md)。 验证：verify 384 项、完整浏览器 35 项、macOS 原生 22 项通过；既有任务只读视觉核对通过，未新增真实模型调用。

最新优化：受 OS 隔离的只读命令按 cwd/额外目录使用共享读锁；长锁返回持有者与可处理的 resource_busy，团队持锁等待与收尾受检查；参数错误提供字段约束。摘要目标与发布上限分离，收齐终态/usage 后校验，避免略超目标就整次作废。verify 380 项、浏览器 34 项、macOS 原生 22 项通过；本地 3000 已重启生效，会话/配置保留、模型调用数未增加。见 [本轮记录](history/2026-09-29-execution-contention-summary.md)。

最新修复：后台命令保留项目锁后，本 Run 的冲突工具不再排队等待自己，改为返回 `process_resource_busy`，让模型读取或停止进程后继续；其他 Run 的资源隔离保持。现场只读慢扫描已定向终止，原任务恢复推进。见 [故障与验证记录](history/2026-09-29-process-lock-progress.md)。

15:32 补充：已正常重启加载修复，并从原主/成员检查点继续；原任务 succeeded，四名成员完成关闭，主报告已生成，无遗留活动进程。8 个会话与模型配置保留。验证 373 项、浏览器 34 项、原生 21 项通过；恢复段 Trace 和证据见上述记录。

最新界面：Trace 独立页面 `/traces/:traceId`，支持 `?span=:spanId` 节点直达、树状层级与统一时间瀑布图、右侧节点详情、搜索/异常筛选/折叠和长链路分页。聊天新标签打开保留草稿；元数据与原始正文仍经原有 SDK 边界读取。见 [本轮界面记录](history/2026-09-29-trace-workbench.md)。verify 371 项、浏览器 34 项通过，桌面/窄屏已核对，本地 3000 已更新；未新增真实模型请求。

最新：执行事实改为有持久锚点的追加快照/增量，避免每步重写 system；双协议工具定义稳定排序、工具预览缩减后不膨胀。页面增加实际缓存命中率及未知请求数。已有 129 请求离线重放的 123 组相邻输入全部保留旧前缀，未新增付费调用；这不是优化后服务商命中率。见 [本轮记录](history/2026-09-29-cache-prefix.md)、[ADR-0019](adr/0019-cache-stable-context.md)。

本轮 `pnpm verify` 367 项、浏览器 31 项通过；本地 3000 已更新，8 个会话与模型配置不变，调用总数仍为 272。缓存收益以用户后续任务的服务商实际 usage 为准。

最新修复：DeepSeek HTTP 402 余额不足原先被误归为普通请求错误；双协议现使用 `model_payment_required` 明确提示。现场 85 次请求中 82 成功、2 余额错误、1 取消，未触发已移除的任务总量限制。见 [现场与修复](history/2026-09-29-model-payment-error.md)。verify 357 项与浏览器定向回归通过，本地 3000 已更新，未新增真实模型请求。

最新：移除主/成员任务的累计产出上限和任务总时限，长任务由上下文压缩持续推进；旧限制字段在恢复时也不生效。单次调用超时、采集边界与用量统计保留，SQLite 仍为 v13。见 [本轮记录](history/2026-09-29-long-running-tasks.md)、[ADR-0018](adr/0018-long-running-tasks.md)。本轮 verify 355 项、浏览器 29 项、macOS 原生 20 项通过；本地 3000 已更新，既有配置与会话保留。

此前：输入区支持“标准权限 / 完全访问”；完全访问跳过命令和资源审批、使用无沙箱进程，成员继承本轮模式，恢复不改变权限。SQLite v13；[协议](protocols/execution-mode-v13.md)、[本轮验证](history/2026-09-29-full-access.md)。
完全访问迭代验收：`pnpm verify` 353 项、浏览器 29 项、macOS 原生 20 项、Docker 28 项检查通过；本地 3000 已更新，原有会话与模型配置保留。


最新修复：审批等待不再拆散主/成员 Trace；停止暂停任务正确收尾；旧执行段按主任务归组，终态由真实 Run 投影。verify 343 项、E2E 28 项通过，本地服务已更新且未重跑原任务。见 [现场分析与修复](history/2026-09-29-trace-lifecycle-fix.md)。

此前：可观测性 v1 已接通，默认只记录元数据；左侧“执行记录与用量”可开启调试，查看每次实际 JSON/SSE 请求与响应。SQLite v12，详见 [本轮交付及验证](history/2026-09-29-observability.md)。

新增 [多 Agent 工具调用与启动展开图](../diagrams/agent-teams-tool-flow.svg)，区分模型工具请求、后端函数、收件箱自动注入及主/成员工具差异，并增加 request / inform / result 三类消息的来源、用途与唤醒行为对照。图表与协议同步，见 [消息设计记录](history/2026-09-29-team-message-types-diagram.md) 和 [原展开记录](history/2026-09-29-agent-teams-tool-flow.md)。

新增 [轻量团队实现图](../diagrams/agent-teams.svg)，展开成员创建的事务与异步启动、持久通信与安全边界、统一交付及共用执行治理。此轮只增加图表和知识入口，见 [记录](history/2026-09-28-agent-teams-diagram.md)。

新增 [多 Agent 七种协作原理图集](../diagrams/multi-agent-patterns/index.html)，覆盖委派、持续子会话、任务板、交接、图编排、群聊与外部运行时接入；提供 Teams / 群聊对比。图集是研究资料，当前已实现其中的轻量团队协作。见 [图表记录](history/2026-09-28-multi-agent-diagrams.md)。

本轮增加 [插件支持链路与原理图](../diagrams/plugins.png)：展示安装确认、Skill/MCP/Hook 接入和版本生命周期；仅更新图表与文档。见 [图表记录](history/2026-09-28-plugin-diagram.md)。

更新时间：2026-10-01。当前里程碑：可观测性 v1、轻量团队 v1、插件 v1、Hook v1、Skill、长期记忆与可恢复上下文。

## 已实现

- 可观测性 v1：Trace/Span/事件、主成员因果链、真实 HTTP 原始 JSON/SSE、有界文件库、独立实际用量与定点价格、Web 时间轴/原文/价格，以及 v12 迁移。调试默认关闭，OTLP 默认关闭；[架构](architecture/observability.md)、[验证与限制](history/2026-09-29-observability.md)。当前数据库统一为 v13，历史小节中的版本是各能力引入版本。

- 轻量团队：成员独立历史、主/成员和成员间通信、共享受控项目、主任务收拢交付、复用/停止/恢复、团队用量统计与全局模型公平队列；Web 团队面板、SQLite v11 和 SSE v6。见 [团队架构](architecture/teams.md)、[本轮记录](history/2026-09-28-agent-teams.md)。

- 插件本地/公开 HTTPS Git 安装预览、准确版本确认、双作用域、启停、更新/回退与延迟卸载；Skill/MCP/Hook 同源版本接入，Web 管理与 SQLite v11。见 [插件架构](architecture/plugins.md)、[本轮记录](history/2026-09-28-plugins.md)。

- 增加 [Hook 报告路径检查示例图](../diagrams/hooks-report-example.png)，附 SVG、Draw.io 和可重建图源，区分程序触发、模型调整与执行授权；见 [图表记录](history/2026-09-28-hook-example-diagram.md)。仅更新图表和文档，不改变运行配置。

- Hook RunStart / PreToolUse / PostToolUse / RunEnd，JSON 与准确包版本确认、默认项目只读、共用锁/槽位/回执、未知副作用隔离和 cleaning 恢复；Web 配置/记录、SQLite v11 与 SSE v5。Kernel 主循环不加 Hook 分支。

- 提供 [Skill 实现原理图](../diagrams/skills.svg)，展示三层加载、单一 Loop、Run 内完整说明和只读包受控执行；见 [图表记录](history/2026-09-27-skill-diagram.md)。本轮仅更新讲解图与文档。

- Skill v1：独立用户/项目来源、本地接入、显式选择和自主加载、完整正文保留、分页资源、只读包与 v8 恢复；见 [本轮记录](history/2026-09-26-skills.md)。插件通过既有受控能力执行。

- 新增 [长期记忆原理图](../diagrams/long-term-memory.svg)，展示后台两阶段提炼、本地分层保存、Run 概览和模型按需查阅；图源与当前源码对应见 [图表资产](../diagrams/README.md)。本轮仅更新图表与文档。

- 新增 [大工具结果原理图](../diagrams/tool-result-handling.svg)：直观展示原文保存、头尾预览及按引用分页补读；图源与源码对应见 [图表资产](../diagrams/README.md)，本轮只更新图表和文档。

- 大工具结果采用原文首尾预览，中间标记与引用、执行状态和 JSON 转义全部计入默认 8000 字符预算；命令日志即时预览 6000 字符。上下文二次缩减从保存原文重建，兼容旧头部预览，正文和采集完整性保持独立。见 [首尾预览迭代](history/2026-09-26-tool-result-preview.md)。

- 上下文管理提供 [原理图](../diagrams/context-management.svg) 与 [源码对照](../diagrams/README.md)，用卡片收拢和同编号查阅展示每次输入、摘要压缩与原记录保留；见 [插画迭代](history/2026-09-26-context-visual.md)。本轮图表不改变产品行为。

- 会话树按项目归组，支持折叠和项目内新建；默认目录聊天保留独立入口。消息参考本机 Qoder 实际界面：用户气泡靠右、助手正文连续展示，中间说明与工具批次按顺序交错。仅显示分组，不改变旧目录身份与授权。见 [项目会话迭代](history/2026-09-26-project-conversations.md)。

- 工作台采用中性浅色、紧凑项目/对话侧栏与输入区模型入口；项目选择改为可搜索的轻量菜单。修复目录设备号变化后无法重新选择的问题：新对话登记新身份，旧会话和权限仍隔离。见 [界面与目录修复](history/2026-09-26-workspace-ui.md)。

- 默认上下文窗口为 200000 token（200k），输出预留 4096；显式容量和在途快照保持不变。见 [默认容量调整](history/2026-09-26-context-default-200k.md)。

- 异步上下文准备：根 AGENTS.md 快照、双协议实际序列化估算、容量设置、有来源的历史/单轮进度摘要、分块任务与事务发布；软阈值优先保留最新工具观察，超限暂停可明确恢复。
- 会话内只读历史工具/API、原文分页、执行事实有界索引；压缩不删除原记录，私有续接不进摘要与公开历史。SQLite v11，新增 v4 上下文事件；content 提供长期记忆读取与纯选择逻辑。
- Web 容量/用量/摘要/来源面板、重试整理与仅应用最新容量；恢复保留原连接、不重放工具、重复请求幂等。详见 [上下文架构](architecture/context-management.md)、[协议](protocols/context-v6.md)、[维护](development/context.md)。

- 命令启动经真实 WASM Shell AST、保守读取清单和用户/项目规则，deny > prompt > allow；规则表单/JSON/静态测试、外部项目准确版本确认，命令与资源合并的一次审批，等待边界及 Worker 就绪前复核。write_stdin 不逐次审批，子进程内部仍依赖资源沙箱。

- 一个自主 runAgent，Responses / Chat Completions 共用内核；不强制计划、反思或固定步骤。
- 26 个核心工具：协作创建/通信/列表/等待/历史/停止，以及计划、时间、文件列表/搜索/读取/写入/编辑、命令启动/读取/输入/停止、结果/对话历史读取、MCP 检索、记忆搜索/读取/更新及技能搜索/加载/资源读取。
- 新对话选择本机目录、最近项目或默认独立目录，首次发送原子绑定与创建幂等；目录内文件操作自主、跨界审批；纯资源支持本次/会话/工作区授权，命令仅本次；支持撤销、参数/定义版本复核。
- 原生 macOS/Linux Worker，真实隔离探测，失败拒绝执行；路径层级锁、每 Run 4 / 全局 8、排他屏障和模型顺序配对。
- MCP stdio / Streamable HTTP、按服务配置 deferred / direct 工具定义（默认按需）、OAuth PKCE/state/刷新及撤销状态说明；远端注释与直接提供均不赋予权限。
- 按需选择同会话跨 Run 持久复用，每次请求校验配置/项目/定义版本；重启重新发现同版本后恢复，断连期间不提供工具，独立会话不共享，缓存不继承审批。
- SQLite v11 上下文及命令/项目/配置迁移、文件提交日志；v3 执行事实、检查点、状态/事件同事务；v1/v2 事件和旧消息兼容；完整结果引用与分页。
- 重启核对回执后手动继续，未知副作用按资源隔离，取消不假装回滚；会话删除保留未解决的最小隔离记录。
- 独立 MCP 设置：用户级/项目级文件与表单、变更确认、按项目隔离的连接状态与工具目录；Web 审批、未知结果核对、进程状态/结果分页及副作用重跑确认，保留现有聊天/IME/草稿/滚动行为。
- 15 个 workspace 中 13 个有业务实现，新增 application/adapters → extensions 依赖边。新代码有中文文件头和关键逻辑注释。

实现入口：[项目与 MCP](architecture/projects-mcp.md)、[v4 协议](protocols/projects-mcp-v4.md)、[项目设置使用](development/projects-mcp.md)、[项目迭代记录](history/2026-09-15-projects-mcp.md)；[工具架构](architecture/tool-execution.md)、[协议与迁移](protocols/execution-v3.md)、[使用说明](development/tools.md)、[工具迭代记录](history/2026-09-15-tool-execution.md)。

权限机制配套提供 [浅色架构图](../diagrams/tool-permissions.png)、[可编辑 Draw.io](../diagrams/tool-permissions.drawio) 和 [矢量 SVG](../diagrams/tool-permissions.svg)，聚焦资源权限、命令规则、用户审批与 OS 沙箱；[图表迭代](history/2026-09-22-tool-permissions-diagram.md) 仅更新讲解材料，不改变执行行为。

## 验证

2026-09-29 观测交付：`pnpm verify` 338 项测试通过，`pnpm test:e2e` 27 项通过，原生隔离 17 项通过，Docker 26 项检查通过。真实双协议均完成成员/工具/摘要链路，各 16 次请求；收尾采集另各补测 1 次且完整。费用因当前连接未配置适用价格保持未知。证据、早期失败与平台限制见 [观测记录](history/2026-09-29-observability.md)。以下记录保留各阶段口径。

轻量团队 v1：`pnpm verify` 321 项、浏览器 25 条、macOS 原生 17 项、Docker 24 项通过。双协议真实模型完成直接通信、主 Agent 参与执行和成员复用；模型关闭成员导致的一次复用未通过记录、Worker 回收修复及容器沙箱限制见 [本轮记录](history/2026-09-28-agent-teams.md)。

插件 v1：工程检查 301 项、浏览器 24 条、原生执行/MCP 16 项通过。公开 Git 真实获取与兼容报告、双协议真实模型、Docker 迁移/持久化的证据及限制见 [本轮记录](history/2026-09-28-plugins.md)。

Hook v1：`pnpm verify` 278 项通过（11 项原生用例单独运行）；浏览器 23 条、macOS 原生/MCP 15 项通过。真实 Responses / Chat Completions 各 7 次请求，完成启动注入、拒绝后自行调整、后处理及成功/失败收尾；原设置未改。Docker 最终镜像 21 项通过，覆盖 v8→v9、配置/快照恢复和备份；当前容器不支持嵌套沙箱，Hook 明确拒绝执行，测试容器和卷已清理。证据见 [本轮记录](history/2026-09-28-hooks.md)。

Skill v1：Node 24 下 `pnpm verify` 262 项通过（含技能 22 项；9 项原生用例另行执行），浏览器 22 条、macOS 原生/MCP 13 项、Docker 19 项通过。真实 Responses / Chat Completions 分别完成自主选择、参考资料、审批脚本、报告产物、显式选择和下一 Run 不继承，各 16 次模型请求，其中 7 次为摘要请求；原配置未改。日志、截图、故障修复及验证边界见 [Skill 交付记录](history/2026-09-26-skills.md)。

长期记忆 v1：`pnpm verify` 240 项通过（含记忆 34 项；7 项原生用例另行执行），浏览器 19 条、macOS 原生/MCP 11 项、Docker 17 项通过。真实 Chat Completions / Responses 均完成两阶段整理、跨会话查阅来源、更正与遗忘，原配置未改；测试容器和卷已清理。验证边界、非阻断检查提示与日志入口见 [本轮记录](history/2026-09-26-long-term-memory.md)。

工具首尾预览迭代 `pnpm verify` 206 项通过（7 项原生用例单独执行）；预览专项 10 项、macOS 原生/MCP 11 项、浏览器 18 条通过。双协议验证使用实际 loopback HTTP 协议替身，本轮未新增付费模型/Docker 验收。见 [验证记录](history/2026-09-26-tool-result-preview.md)。

最新项目会话迭代 `pnpm verify` 196 项、浏览器 18 条通过；真实 Qoder 参考、会话归类、工具时间线与桌面/手机视觉边界见 [项目会话记录](history/2026-09-26-project-conversations.md)。此前目录重选回归见 [界面记录](history/2026-09-26-workspace-ui.md)。

上下文迭代 `pnpm verify` 192 项通过（6 项原生用例另行执行），浏览器 16 条、原生专项 10 项、Docker 14 项通过。真实 Chat Completions / Responses 均通过压缩后继续及历史细节找回，原配置未改变。工程、浏览器、Docker 与真实协议证据分别见 [2026-09-26 上下文记录](history/2026-09-26-context-management.md)。

前轮命令权限验收见 [2026-09-22 记录](history/2026-09-22-command-permissions.md)：`pnpm verify` 171 项通过、6 项原生专项在独立命令运行；`pnpm test:e2e` 15 条通过，macOS 原生专项 10 项通过，Docker linux/arm64 / Node 24.20.0 共 12 项通过。覆盖真实 AST、命令/资源双重约束、规则文件并发与恢复、旧授权升级、浏览器草稿保护、真实批准前后副作用、WASM 生产打包、v1→v5 与重启/备份恢复。日志 `.cache/command-policy-{verify,e2e,native,docker}.log`；容器和测试卷已清理，本轮未新增真实模型验收。

此前阶段验证保留如下。

前轮会话复用验收见 [2026-09-22 迭代](history/2026-09-22-mcp-session-selection.md)：`pnpm verify` 127 项通过、5 项原生专项跳过，`pnpm test:e2e` 12 条通过。新增 12 项选择测试，两种模型协议均验证重启后的追问无需重新搜索，浏览器验证刷新追问只产生一次 MCP 调用。日志 `.cache/mcp-selection-verify.log`、`.cache/mcp-selection-e2e.log`；本轮使用本地协议替身，未新增真实模型或生产 MCP 验收。

前轮工具提供方式验收见 [2026-09-22 迭代](history/2026-09-22-mcp-tool-exposure.md)：`pnpm verify` 115 项通过、5 项原生专项跳过，`pnpm test:e2e` 12 条通过。新增 7 项 MCP 提供方式集成测试，包含双模型协议实际 loopback HTTP 请求、审批与配置持久化；未新增真实模型/外部 MCP 验收。报告为 `.cache/mcp-tool-exposure-verify.log`、`.cache/mcp-tool-exposure-e2e.log`。

以下为 2026-09-15 基线证据。

- `pnpm verify`：108 项测试通过，5 个原生用例在独立命令运行；格式、类型、依赖边界、文档和生产构建通过。报告 `.cache/project-mcp-verify-final.log`。
- `pnpm test:e2e`：12 条浏览器流程通过。报告 `.cache/project-mcp-e2e-final.log`。
- macOS 原生执行与 MCP 专项：9 项通过。报告 `.cache/project-mcp-native-final.log`。
- Docker linux/arm64 / Node 24.20.0：11 项检查通过，覆盖 v1→v4、独立工作区卷、备份恢复、双协议和 SIGKILL 恢复；测试卷/容器已清理。报告 `.cache/project-mcp-docker-final.log`、`.cache/acceptance/docker.json`。
- 项目/MCP 新增专项：11 项通过，含配置故障恢复和无关服务不中断。报告 `.cache/project-mcp-tests-final.log`。

- macOS 原生目录窗口实际选择与取消通过，报告 `.cache/acceptance/native-picker.json`；Linux 桌面窗口未实机验收。
- 真实 DeepSeek deepseek-v4-flash / Chat Completions：默认目录和手动指定目录各 4 Step / 4 次模型请求，实际文件/命令核验通过，原配置未改变。报告 `.cache/acceptance/projects-live.json`。
- 原生隔离与双协议执行基线见 [前轮记录](history/2026-09-15-tool-execution.md)。MCP 使用真实本地协议替身，不代表所有外部生产服务已兼容。

## 仍为骨架与边界

testing 包、CLI 保持骨架，orchestration 已接通轻量团队协调，extensions 的插件能力复用既有受控执行系统。未实现向量记忆检索、知识库、嵌套项目规则、Workflow、外部 Agent、递归子团队和自动化端到端任务质量评价。已提供独立8题创作资料与人工/模型裁判协议，尚无真实任务评分结果。当前工具层不表示整个 Agent 平台已完成。

仅可信本机单用户；无账号、公网、多租户。Windows、PTY、跨 Run 后台任务、模型托管工具、MCP sampling/elicitation/tasks 未实现。命令网络仅具体公网域名；原生进程组回收不能承诺任意恶意脱组守护进程的消失。凭证受本地权限保护但未加密；文件哈希和 rename 不构成跨外部编辑器的强事务。完整结果库有额度，Worker 临时审计数据没有全局磁盘清理器。

升级前备份整个数据目录及独立工作区；v13 回退须恢复升级前备份。原 HTML/图表及历史线上报告未自动发布。本轮代码、测试和文档仍在本地工作区，没有提交推送。后续从 [记忆架构](architecture/memory.md)、[上下文架构](architecture/context-management.md) 和 [路线](roadmap.md) 展开。

本机生产启动使用 `pnpm build && pnpm start`，默认地址 `http://127.0.0.1:3000/`。2026-09-22 验收使用隔离测试实例，结束时未启动用户数据目录中的长期服务；此前升级的完整备份路径记录在 `.cache/project-mcp-backup.json`。
