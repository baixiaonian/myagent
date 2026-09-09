# 当前状态

更新时间：2026-09-09。当前里程碑：MyAgent 本地 Web Chat v1（代码 0.1.0）。

## 已实现

当前代码的请求、落库和回答回传可对照 [聊天实现链路图](architecture/chat-flow.md)，图中关联原架构编号、源码入口和两个开发阶段的提交。

手写代码已补充中文文件职责与关键逻辑注释（54 个源文件，另覆盖 12 个构建 / 配置入口），后续遵循 [中文注释规范](development/comments.md)。本轮只补注释与知识，不改变聊天行为或数据格式。

- 15 个 workspace 保持原模块边界，其中 contracts / sdk / kernel / state / application / adapters / web / server 实现聊天闭环。
- 本机设置、自有 OpenAI 兼容接口和密钥、实际连接测试、运行时配置快照。
- 会话创建 / 切换 / 标题生成 / 重命名 / 删除，多轮流式回答、停止、重试、成功才替换原答的重新生成。
- 安全 Markdown、表格、代码高亮、消息 / 代码复制、IME-safe Enter、内存草稿、阅读时停止自动滚动、窄屏抽屉。
- SQLite WAL / Drizzle 初始迁移、请求幂等、revision 冲突、每会话单运行、持久事件和 SSE 补读、重启标记中断、删除后的迟到结果保护。
- 独立文件凭证与文件权限、脱敏 API / 错误 / 日志、本机 Host / Origin 边界、超时 / 上下文预算、关闭模型 SDK 自动重试和日志。
- 一次启动开发命令、生产构建 / 统一启动、Dockerfile / Compose / 数据卷 / 健康检查。

## 验证证据

2026-09-09 注释迭代：`pnpm verify` 通过，32 项测试与构建通过；47 个 TS/JS 文件的语法树及去注释编译输出一致，Python 语法树与其他代码去注释文本一致，SQLite 迁移结构未变，`docker compose config --quiet` 通过。详细范围见 [中文注释补充记录](history/2026-09-09-chinese-code-comments.md)。以下真实模型、浏览器及容器运行结果沿用之前已完成的验收，本轮未重复执行这些产品测试。

`pnpm verify` 通过（格式、架构、文档、类型、32 项测试、生产构建与浏览器产物边界检查）；`pnpm test:e2e` 的 5 组 Chromium 流程通过。生产服务、开发命令及自定义端口代理已启动检查；浏览器检查了首次配置和工作台布局。`docker compose config --quiet` 通过。

用户配置的 DeepSeek `deepseek-v4-flash` 已完成真实连接、两轮随机暗号记忆、重新生成、文字流停止与保存、Web Markdown 和刷新恢复验收。本机服务重启后会话快照完全一致，配置未变。

Docker 镜像 `myagent:acceptance-v1` 在 Node 24.20.0 / linux/arm64 完成构建和 7 组运行验收：健康检查、普通用户 / loopback / 权限、Web / API、SQLite 持久化、正常重启、完整卷备份恢复、SIGKILL 中断恢复及清理。容器测试使用独立假模型和测试卷，不使用用户真实凭证。

本机环境 Node 25.2.1 / pnpm 11.7.0；Docker Engine 29.4.0、Compose 5.1.2。远程 CI 仍只有配置，没有远程执行证据；本轮没有验证 linux/amd64 或其他服务商。

详细范围见 [测试说明](development/testing.md) 和 [最新补充验收](history/2026-09-08-live-model-and-docker-acceptance.md)。

## 仍是骨架

工具 / Policy / Interaction / Execution、Task / Invocation、content（记忆 / 检索 / 产物）、extensions（插件 / Skill / Hook）、orchestration（Workflow / 调度 / 子 Agent）、observability、testing 包、CLI 和 Worker。`tests/chat/provider.ts` 是本轮测试服务，不代表完整 testing 包已实现。config 中预留 YAML 不被运行时加载。

## 交付边界与接续

仅可信本机单用户，无公网部署、账号、多租户、图片、附件、联网或 RAG。凭证文件未加密，备份需受限保护；输入草稿仅当前页面内存；事件 / 答案版本一直保存到主动删除会话。读取 [维护说明](development/setup.md) 了解升级、恢复与完整删除。

原设计 HTML / 总图 / 上游研究保持原状，未重新发布历史在线报告；当前实现链路图单独维护。Git 远程为私有仓库 [baixiaonian/myagent](https://github.com/baixiaonian/myagent)，origin 使用 SSH，主分支为 main。开发基线的前两个提交为“工程骨架初始化 → 本地 Web 聊天机器人”，分别通过 8 项与 32 项测试及构建；后续图表、注释等迭代独立追加提交。拆分依据与验证见 [提交历史整理](history/2026-09-08-commit-history-split.md)，后续遵循 [提交规范](development/commits.md)。下一轮从 [路线](roadmap.md) 与 [AGENTS](../AGENTS.md) 继续。
