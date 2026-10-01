# 2026-09-29：可观测性 v1

## 完成范围

接通可观测性模块、实际 HTTP 边界原始材料、独立调用账本、定点费用、版本化价格、Trace 与时间轴、独立模型请求/用量页面，以及 SQLite v12。主/成员、步骤、工具、审批、进程、MCP、Hook、技能、上下文与后台记忆通过中立身份关联。普通聊天 SSE 仍为 v6，Agent Loop 没有观测驱动的决策或重试。

原始采集在每次请求开始冻结开关；只保存 JSON/SSE 正文与白名单响应元数据。文件有界异步写入、原子发布、重启对账和清理。SDK 提前停止消费时原始流收拢最多 150ms，只有真实 EOF 能标完整。账本写入故障阻止新付费请求，诊断或导出故障不改变业务。

关键入口：`packages/application/src/observability.ts`、`packages/adapters/src/observability/`、`packages/observability/src/index.ts`、`apps/web/src/features/observability/`、`migrations/0012_observability.sql`。application 新增 observability 依赖；CLI/testing 仍为骨架，其余原能力不另造状态源。

## 验证记录

- `pnpm verify`：Node 24.19.0，格式、依赖边界、文档、类型、338 项测试、生产构建与客户端凭证边界均通过；13 个平台用例由独立原生命令启用或按平台跳过。证据 `.cache/observability-verify.log`。保留已有非阻断 lint 提示及 Web 大包提示，没有通过降低检查规则隐藏它们。
- 观测专项共 17 项，随全量 verify 通过：实际 HTTP 输入/输出字节、延迟 EOF、开关快照、usage、价格分档与多币种、取消、采集故障、匿名化、保留清理、真实 v11→v12 及文件完整性校验。OTLP 本地接收器实际解码 protobuf 的身份、父子、事件与 Link；团队关联另由既有双协议团队用例覆盖。
- `pnpm test:e2e`：27 项全部通过，证据 `.cache/observability-e2e-final.log`。新增调试开关、时间轴、原始材料/下载哈希、价格、关闭调试、刷新与草稿，以及超过一页的记录在每秒刷新和新记录到达后仍保留；截图 `.cache/acceptance/observability-trace.png`。
- `pnpm test:execution:native`：macOS 17 项全部通过，证据 `.cache/observability-native.log`。
- Docker linux/arm64 / Node 24.20.0：26 项检查通过，包含真实 v11 数据卷升级 v12、用量/原始材料保存与哈希、重启、备份恢复及 SIGKILL。证据 `.cache/observability-docker.log`、`.cache/acceptance/observability-docker.json`。容器不支持嵌套原生沙箱，已验证 `unavailable_refused`，不能把这一结果称为容器脚本隔离成功。测试容器、网络和卷已清理；最终分页界面另由浏览器用例验收。

## 真实模型证据与失败边界

隔离实例只读现有授权配置，调用密钥经 FileCredentialStore 进入内存；用户配置前后比较相同。原始材料只留验收临时目录，报告不含正文、密钥或私有推理。

最终自然语言任务为“主 Agent 核对 expenses-a.txt，安排成员核对 expenses-b.txt，汇总费用，再查阅原对话核对项目代号”。两种协议各完成 16 次实际请求、1 名成员、2 份已发布摘要；请求数量与独立账本一致，每次输入/输出有大小和 SHA-256 证据。Responses 实际用量为输入 150789 / 输出 8071；Chat Completions 为输入 143270 / 输出 7690。所有请求 usage 已取得，但没有适用的已配置价格，因此全部显示未计价，未冒充真实账单费用。

前两次验收分别停在审批、触及脚本 24 次请求保护上限。过低窗口/阈值组合导致反复整理；记录保存在 `.cache/acceptance/observability-live-initial.json` 和 `observability-live-small-window.json`，未计为通过。最终改用产品默认 200k 窗口和静态费用资料，报告为 `.cache/acceptance/observability-live.json`。模型未被模拟替代。

上述全链路记录中，Chat SDK `[DONE]` 提前结束使原始输出标 partial。之后调整 HTTP 尾部收拢，专项已断言双协议完整 EOF；追加真实传输检查：Responses / Chat Completions 各 1 次请求，输入和输出全部 complete，大小和 SHA-256 核验一致；证据 `.cache/acceptance/observability-transport-live.json`。修复前的 partial 证据保留在 `observability-transport-before-fix.json`，不把旧记录改成 complete。

## 维护与接续

已同步根及 application/adapters/state/kernel/server/web 局部 AGENTS；Worker、SDK、测试与脚本既有局部规则已检查，无需新增权限规则；新增 observability 局部约束、ADR-0016、架构、协议、使用说明和知识索引。私有续接原始调试读取是明确例外，普通 API/SSE/日志/Agent 工具/OTLP 继续禁止正文。

DeepSeek 工作日高峰的节假日条件未内置，信息不足不自动计价；外部代理只用手工价格。无独立指标或日志后端、公网模式、后台正文外发及历史批量重新计价。保留已有未提交改动，本轮未提交、推送或部署公共服务。
