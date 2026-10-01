# 验证策略与证据

## 当前自动化

`pnpm verify` 依次执行 Biome、模块边界检查、文档链接 / 必需文件检查、TypeScript、Vitest、生产构建和客户端产物检查。当前默认 Vitest 338 项通过、13 项按原生平台策略跳过，独立原生命令运行 17 项；覆盖聊天、Loop、工具、上下文、记忆、扩展、团队与观测。最新证据见 [观测迭代](../history/2026-09-29-observability.md)。

| 范围 | 覆盖 |
| --- | --- |
| 内核与上下文 | 无计划直接回答、工具独占 / 混合输出、多次反馈、顺序批次、动态 / 清空计划、未知工具与参数错误修正、完整历史裁剪、续接与输出容量、取消、工具 / 模型 / Run 超时和忽略取消的实现 |
| 持久化 / 并发 | 原子问题 / Run、重复请求、同会话冲突、revision、重放和重复事件投影、Last-Event-ID、恢复中断、删除迟到结果、目录单实例锁、可写数据目录 / 只读父目录 |
| 模型适配 | 两种协议通过官方 SDK 发真实本地 HTTP 请求；文字 / 参数分片、工具 ID 配对、Responses Item 顺序 / encrypted_content / 无状态请求、Chat reasoning_content、实际及缺少 usage、401 / 404 / 429 / 400、异常断流、取消；截断 / 缺失重复 ID / 不完整 Item / 终态后输出都不能执行工具 |
| Agent 持久化 | 调用先提交再执行、结果先提交再继续、私有续接不进入公开快照 / SSE、协议在途快照与切换后的普通历史、v1 配置 / 消息 / 事件升级、未完成步骤恢复、重新生成失败保留原答和计划、迟到写入拒绝 |
| 设置与凭证 | 未保存配置的连接测试、密钥读取掩码、DB / WAL 不含测试密钥、权限 0700 / 0600、保持 / 替换 / 清除、上游回显错误与日志脱敏 |
| HTTP 边界 | Host / Origin / 跨站请求、JSON 内容类型、严格 schema、非法游标 |
| 构建边界 | Web JS / CSS / HTML 不含服务端适配器、凭证文件路径与测试密钥 |

`pnpm test:e2e` 先构建，再使用独立临时数据目录和两个 loopback 服务（14317 产品、14318 假模型），单 worker Chromium，当前 27 项流程。下列为基础聊天例子，完整覆盖见 `tests/e2e/` 和最近迭代：

1. 首次设置 / 连接测试、Markdown / 高亮 / 复制 / 禁止 HTML、两轮聊天、重新生成、刷新、切换、重命名、删除。
2. composition 事件合成测试与 Shift+Enter、生成中刷新恢复、草稿保留、停止、重新生成失败保留原答。
3. 390px 窄屏抽屉、无页面横向溢出、清除密钥。
4. POST 已到服务器但浏览器未收到响应，重试复用原 requestId，避免重复问题和调用。
5. 长文流式回答时向上阅读，停止自动跟随，提供回到底部。
6. Responses 协议配置、Agent 多步工具、计划更新、参数结果展开、刷新恢复和重新生成。
7. Chat Completions 协议下同样的 Agent 产品闭环。

首次安装浏览器：`pnpm exec playwright install chromium`（Linux CI 加 `--with-deps`）。失败保留截图和 trace，HTML 报告在 `playwright-report/`；这些目录已忽略 Git。端口被占用时不杀其他进程，应同时调整 playwright.config.ts、serve.ts 和测试中的地址。测试目录退出会清理；SIGKILL 后可能留下 OS 临时目录，需要确认后自行清理。

## 已运行与未运行

当前工具系统验证见 [本轮验收记录](../history/2026-09-15-tool-execution.md) 和 [STATUS](../STATUS.md)。原 Loop 的 74 项测试、7 组 E2E 和双协议工具证据保留在 [上轮记录](../history/2026-09-12-agent-loop.md)。下述聊天验收为历史基线，不能替代 Agent 新能力证据。

用户配置的 DeepSeek `deepseek-v4-flash` 已通过真实多轮 / 重新生成 / 停止 / 持久化验收；Web 输入真实问题返回 Markdown，刷新后四轮问答与停止部分完整保留；服务重启前后会话快照 SHA-256 一致。

Docker Engine 29.4.0 / Compose 5.1.2，镜像在 Node 24.20.0、linux/arm64 上构建成功。已验证 7 组容器场景，包括普通用户和安全边界、Web 资源、模型 HTTP / SQLite、正常重启、备份恢复到独立新卷、实际 SIGKILL 后 interrupted 和日志 / 删除 / 清理。全部容器测试使用假密钥和独立卷。

CI 工作流包含 verify 和 E2E，但没有远程运行记录。未验证 linux/amd64 或所有兼容服务商。本机 Node 25.2.1，推荐 Node 24 LTS。详细结果见 [补充验收记录](../history/2026-09-08-live-model-and-docker-acceptance.md)。

## 真实模型验收步骤

1. 正常启动产品，在设置页填写用户自己的真实地址、模型和密钥，测试连接并保存。
2. 连续提两轮相关问题，第二轮检查是否正确理解第一轮上下文；确认流式显示、模型端实际调用和正常终态。
3. 刷新确认历史恢复，停止一次长回答，检查部分文本仍在；不自动发起任何额外模型调用。
4. 记录服务商 / 模型、日期、成功 / 失败、轮次、取消结果；不记录密钥或敏感聊天全文。后续真实结果应另写新历史，不覆盖早期“未验收”记录。

受控工具、沙箱和 MCP 已实现；RAG、编排和任务质量评测仍未实现。MCP 用本地真实协议替身验证，不能代替任意生产 MCP 兼容结论。

## 独立验收命令

- `MYAGENT_TEST_URL=http://127.0.0.1:3001 pnpm test:live`：仅在用户授权真实模型请求后执行。使用现有配置，创建专用会话，验证连接测试、多轮随机暗号、重复提交、重新生成、停止与恢复；保留会话用于人工复核。结果在 `.cache/acceptance/live-model.json`，不包含密钥或完整聊天。
- `pnpm test:agent:live`：仅在用户授权后执行，读取 `MYAGENT_SOURCE_DATA_DIR`（默认 `~/.myagent/`）的原配置，用已有凭证服务在内存注入独立临时实例，分别测试两种协议的计划创建 / 更新、真实时间、多次模型交互和追问。原配置不改协议、不迁移、不写入验收会话；临时配置只存占位凭证，最终清理。报告 `.cache/acceptance/agent-live.json`。真实服务不支持某协议会记录失败，不回退协议或用假模型替代。
- `pnpm test:docker`：构建 `myagent:acceptance-v1`（延续既有验收标签），使用 Compose 唯一测试 project / 随机 loopback 端口和假模型，10 组检查包括真实 v1→v3 升级、双协议工具及计划、健康检查、权限、持久化、重启、独立卷恢复、SIGKILL 恢复和删除。结束仅清理脚本创建的容器、网络与卷；镜像保留。结果在 `.cache/acceptance/docker.json`。

这些独立验收命令不加入默认 verify：真实模型会产生费用，Docker 需要已启动 engine。真实模型脚本只操作它创建的会话，Docker 测试不使用真实模型配置或用户数据。CI 包含工程检查、假模型浏览器与 macOS/Linux 原生执行验证；未推送触发本轮远端运行。

## 工具专项

- `pnpm test:execution`：参数、路径、Policy、锁、结果分页、审批、故障注入与恢复，默认跳过原生平台用例。
- `pnpm test:execution:native`：真实 macOS/Linux 文件和命令隔离、输入输出、进程终止，以及 stdio MCP；失败不降级。
- `pnpm test:execution:live`：已有模型配置只读，密钥在内存注入独立实例，用自然语言执行文件修改和命令验证，并追问文件名。没有指定工具名称/轮数，报告 `.cache/acceptance/execution-live.json`。
- `scripts/test-native-smoke.mjs`：生产适配器冒烟，无 Vitest 依赖，适用于独立 Linux 测试环境。测试容器的额外命名空间权限不写入产品 Compose。

浏览器工具流程另有 `tests/e2e/execution.spec.ts`：工作区绑定、刷新审批和拒绝、MCP 目录、批准、结果分页、重跑确认、授权撤销及未知结果人工核对。完整结果与命令输出以纯文本展示；测试图在 `.cache/tool-execution/`。

项目与 MCP 管理使用 `tests/execution/projects-mcp.test.ts` 和扩展 E2E 验证。当前矩阵/结果见 [项目改造记录](../history/2026-09-15-projects-mcp.md)。`pnpm test:projects:live` 需真实模型授权；默认目录与指定目录任务分别记录，不把注入目录选择器当作原生窗口验收。

命令专项：tests/execution/commands.test.ts / command-api.test.ts 覆盖真实 AST、规则、配置提交恢复、审批及重启；native.test.ts 验证批准前后真实副作用、沙箱独立约束和交互输入。E2E 覆盖命令卡/设置页面，Docker 验证生产仅依赖安装后的 WASM 和配置恢复。操作入口见 [命令权限](commands.md)。

上下文专项：`pnpm test:context`。覆盖单轮巨大消息/结果、摘要分块、失败暂停、取消与恢复、双协议估算及历史白名单。真实验收 `pnpm test:context:live` 必须有模型授权，不进 CI；说明见 [上下文维护](context.md)。

长期记忆新增 `pnpm test:memory` 与 `pnpm test:memory:live`；后者需要有效模型授权，仅临时实例调用。两阶段整理用量与前台聊天分开计数，报告不含正文/凭证；见 [记忆验收说明](memory.md)。

Skill 专项：`pnpm test:skills`，真实双协议：`pnpm test:skills:live`（需真实模型授权）；脚本隔离包含在 `pnpm test:execution:native`。流程和证据见 [Skill 使用](skills.md)。

## Hook v1

`pnpm test:hooks` 覆盖配置 CAS/包确认、四事件顺序、前置拒绝、故障策略、来源上下文、结果首尾预览、取消/迟到结果、日志对账、重启核对与 cleaning 恢复。`pnpm test:execution:native` 额外执行真实脚本隔离和旧包恢复。`pnpm test:hooks:live` 在已授权连接上独立验收两协议，结果位于 `.cache/acceptance/hooks-live.json`；不修改用户设置，不纳入 CI。Docker 从 v8 卷验收到 v9，沙箱不支持时必须拒绝，不能把持久化通过称为原生隔离通过。

团队验证：`pnpm test:teams`、`pnpm test:teams:live`；双协议付费验收、工程替身、浏览器与原生隔离分别记录，见 [使用维护](teams.md)。

观测 v1 使用 `pnpm test:observability`、`tests/e2e/observability.spec.ts` 与 `pnpm test:observability:live`。真实 HTTP 本文对比、OTLP protobuf 接收、账本和材料故障分别验证；私有正文仅原始调试接口可见的例外不能影响旧 SSE/普通历史断言。本轮 Node 24 专项及最终工程证据见 [观测迭代](../history/2026-09-29-observability.md)。
