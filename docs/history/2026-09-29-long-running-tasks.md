# 2026-09-29：移除任务累计产出与总时限

## 目的与变化

用户要求持续执行长任务，并确认同时取消默认 200000 字符累计额度和 10 分钟任务总时限。Kernel 删除总截止计时与累计输出拒绝；ContextService / Summarizer 不再以旧剩余额度拒绝整理；ChatService 恢复和维护不再触发任务总超时；TeamService 不再因累计统计取消主任务或拒绝创建成员。

累计产出和活动时间仍保存，便于排查。单次模型/工具超时、上下文窗口、原文采集边界、用户停止和未知副作用治理保持。`exec_command` 的默认单进程时限独立为 600000ms，可用 `MYAGENT_COMMAND_TIMEOUT_MS` 覆盖，不再借用任务总时限。

## 兼容与知识

旧环境变量 `MYAGENT_RUN_TIMEOUT_MS` / `MYAGENT_OUTPUT_CHARACTERS` 提示停用并忽略。旧检查点和团队记录中的限制字段不再参与控制，活动/产出数字只统计；没有数据库结构变更，仍使用 v13。已终结的用户任务不被自动恢复或重跑。

同步根与相关局部 AGENTS、Loop/团队/上下文/执行/观测架构、恢复协议和使用说明。新增 [ADR-0018](../adr/0018-long-running-tasks.md)。模块职责及依赖未变化，未改模块依赖清单；既有未提交改动保留。

## 验证

专项测试通过：上下文 23 项，Agent/团队/恢复 72 项。包含真实 ContextService 与 SQLite 的单轮 25 万余字符、多次压缩、8 次工具调用和正常交付；注入超过旧累计量/时间的持久状态后创建成员并收拢结果（不以真实等待十分钟作为证据）；旧检查点重启后人工继续且不重放工具；摘要累计超过旧上限后仍可分块；单次模型/工具超时及取消保持。

- `pnpm verify`：355 项通过、14 项按配置跳过，类型、依赖/文档检查和生产构建通过。日志 `.cache/long-task-verify.log`；保留既有 lint 警告与前端 bundle 体积提示。
- `pnpm test:e2e`：29 项通过，包含双协议聊天、团队、审批、压缩和停止。日志 `.cache/long-task-e2e.log`。
- `pnpm test:execution:native`：macOS 原生执行与协议 20 项通过。日志 `.cache/long-task-native.log`。
- 专项日志：`.cache/long-task-context.log`、`.cache/long-task-targeted.log`。模型为本地确定性替身，不代表真实服务商长任务可靠性；未重复 Docker 和真实付费模型验收。

## 本地运行

确认无活动任务后停止旧实例，完整受限备份并核验 SQLite integrity=ok；备份位置记录在 `.cache/long-task-local-backup.json`。本地生产实例在 3000 使用新构建启动，数据库 v13、7 个会话、模型设置和调试开关保持。重启前后模型调用记录均 58 条，原问题任务仍为 cancelled，没有自动请求或重放。只读核验见 `.cache/long-task-local-before.json` 与 `.cache/long-task-local-after.json`。

本轮没有提交、推送或部署公共服务。
