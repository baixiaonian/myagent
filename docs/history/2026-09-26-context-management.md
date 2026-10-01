# 2026-09-26：可恢复的上下文管理

## 完成范围

接通 ContextService / ContextSummarizer、异步内核端口、预算与分块、根规则快照、来源指纹、摘要事务发布、历史工具/API、容量与恢复界面。SQLite 升级 v6；新增上下文事件 v4，历史事件兼容。协议、模块关系、产品说明和根/相关局部 AGENTS 已检查更新；中文注释与关键竞态说明同步。

历史事实仍保存在原消息、Step、invocation 和结果文件，压缩只改派生视图。候选回答、旧连接续接、未知副作用和授权保持各自边界。MemoryProvider 本轮仅空读取实现，无自动记忆、向量检索或嵌套规则。

## 验证证据

本轮验证已完成，模拟协议、真实模型和原生隔离的证据分别记录：

| 验证 | 结果与证据 |
| --- | --- |
| `pnpm verify` | 192 项通过，6 项原生用例在该命令中跳过；格式、类型、依赖边界、文档、生产构建和前端凭证边界检查通过。日志 `.cache/context-verify.log` |
| `pnpm test:e2e` | 16 条 Chromium 流程通过，含容量设置、压缩状态、摘要及来源查阅。日志 `.cache/context-e2e.log`，截图 `.cache/acceptance/context-ui.png` |
| `pnpm test:execution:native` | 10 项本机原生执行与 MCP 专项通过。日志 `.cache/context-native.log` |
| `pnpm test:docker` | linux/arm64、Node 24.20.0 下 14 项通过，覆盖旧数据卷升级 v6、双协议压缩、来源分页、重启、备份恢复和 SIGKILL 恢复；临时容器与卷已清理。日志 `.cache/context-docker-release.log`，报告 `.cache/acceptance/docker.json` |

上下文专项包含纯预算、完整批次、单轮压缩、摘要分块、取消与迟到响应、失败恢复、双协议序列化、历史分页与私有字段边界；已纳入 `pnpm verify`，也可单独运行 `pnpm test:context`。

真实验收使用已有配置在独立临时实例执行自然语言时间查询和项目代号原文核对，未修改用户配置：

| 协议 | 模型请求总数 | 已发布摘要 | 历史工具读取 | 结果 |
| --- | ---: | ---: | ---: | --- |
| Chat Completions | 7 | 2 | 3 | 通过 |
| Responses | 5 | 1 | 2 | 通过 |

报告 `.cache/acceptance/context-live.json` 的 originalSettingsUnchanged=true。测试目录已清理；模型请求数包含整理请求，摘要数量不等于所有计费请求数量。

首次真实实验把触发阈值压得低于固定输入占用，暴露过早压缩最新工具结果导致重复查询的问题，已主动停止该次实验并记录 `.cache/acceptance/context-live-aborted.json`（41 个决策步骤、40 次整理请求）。修正后软阈值优先保留最新完整观察，只有确实无法容纳才替换；增加回归测试后重新真实验收通过。验收脚本加 24 次请求的费用保险，该限制不属于产品 Agent Loop。

## 限制与接续

字节/token 为估算，摘要仍可能遗漏，需要来源查阅和原执行事实兜底。采集结果有额度；省略总量未知时保留 null。Web 构建仍有既有包体提示，不影响本地启动。业务循环没有固定轮数和强制计划。

未提交、推送或部署；保留了本轮开始时已有的未提交工作。维护与升级见 [说明](../development/context.md)，实现边界见 [架构](../architecture/context-management.md) 和 [ADR-0010](../adr/0010-context-management.md)。
