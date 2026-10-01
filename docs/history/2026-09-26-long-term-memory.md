# 2026-09-26：长期记忆 v1

## 目的与范围

实现用户确认的跨会话长期记忆计划，不增加独立会话笔记、Agent Loop、子 Agent 或向量数据库。保留本轮开始时已有的工作区改动，不自动提交推送或部署。

## 完成内容

- content/contracts/state：记忆条目、来源、任务、设置协议，完整条目概览预算，文件端口和持久状态；SQLite v6→v7 默认关闭，不伪造历史或调用模型。
- application：MemoryService 统一文件发布、外部编辑、索引恢复、人工版本、删除排除与来源撤销；后台两阶段无工具请求、分块/有界合并、调用额度、前台优先、连接快照及中断恢复。
- adapters/server：Markdown 固定格式与安全路径、CAS/fsync/rename 和持久提交日志，三个记忆工具及独立 API；受保护数据根使用规范真实路径，修复 macOS `/var` 与 `/private/var` 别名绕过。
- context/SDK/Web：Run 概览快照及撤销，独立设置页、正文/来源分页、人工更新/遗忘/撤销、后台队列及实际用量。会话读/写贡献开关分离，设置页面不建空会话。
- 工程：记忆专项、双协议 HTTP、浏览器、Docker、独立真实模型验收脚本；未新增运行时依赖。

## 验证证据

- `pnpm verify`：240 项通过，7 项原生用例在独立命令运行；格式、类型、依赖边界、文档和生产构建检查通过。日志 `.cache/memory-verify.log`。
- 其中记忆专项 34 项（含两种协议），覆盖故障注入、发布期间取消回滚、来源变化、重启用量未知、分块/增量预算、人工保护、混合来源重建、空文件保护、压缩后快照以及 v6→v7 保留旧记录。
- `pnpm test:e2e`：19 条通过。长期记忆入口不创建会话，编辑/遗忘/撤销、后台提炼与来源可查；截图已人工查看，无正文溢出。日志 `.cache/memory-e2e.log`，截图 `.cache/acceptance/memory-ui.png`。
- `pnpm test:execution:native`：macOS 原生/MCP 11 项通过。日志 `.cache/memory-native.log`。
- `pnpm test:docker`：linux/arm64 / Node 24.20.0 共 17 项通过，包含 v1→v7、记忆文件与索引重启、整卷备份恢复、双协议两阶段整理、会话删除撤销、既有上下文和 SIGKILL 恢复。报告 `.cache/acceptance/docker.json`，日志 `.cache/memory-docker.log`；测试容器与卷清理完毕。
- `git diff --check` 通过。没有提交、推送或部署。

静态检查保留非空断言等非阻断建议；Vite 提示主包大于 500 kB，目前未为了本轮功能额外拆分既有前端包。

真实模型在独立临时实例验收：Chat Completions 14 次请求（后台 2，搜索 6、查阅 3、更新 2），Responses 11 次（后台 2，搜索 2、查阅 1、更新 2）。两种协议均完成 A 会话知识提炼 → B 会话核对来源 → 更正 → 遗忘 → 新会话不再注入旧条目。原模型配置校验未变化；临时实例和文件清理。证据 `.cache/acceptance/memory-live.json`、`.cache/memory-live.log`，没有原始凭证/请求正文。

Docker 初轮记忆专项通过；既有上下文案例因默认窗口已经调整为 200k，长文本没有达到压缩阈值，已将验收案例显式设为 32768 后重跑并全部通过。这是测试条件修正，不调整产品默认容量。

## 边界与接续

正文上限 4 MiB，条目 12000 字符；概览最多 2500 估算 token / 输入预算 10%，查询最多 20 项/8000 字符。暂不提供语义向量检索、后台自动 Skill 或团队共享。提炼准确性依赖模型，用户可查来源和更正；敏感形态过滤不保证识别任意秘密。任意外部编辑器不参加文件事务，冲突会报错而非覆盖。

已检查并更新根与相关局部 AGENTS；同步 STATUS、模块清单、架构、v7 协议、ADR 0011 和使用维护。接续入口：[记忆架构](../architecture/memory.md)、[使用说明](../development/memory.md)、[协议](../protocols/memory-v7.md)。
