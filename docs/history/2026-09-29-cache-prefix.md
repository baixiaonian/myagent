# 2026-09-29：缓存前缀优化与真实命中率展示

## 目的与现场

用户反馈一次长任务消耗约 10 元且没有交付，要求参考 Codex 尽量命中缓存。只读已保存的 129 次请求：124 成功、3 次 HTTP 402、2 次取消；已知输入 5,306,189、输出 63,357、缓存输入 665,728 token。输入加权命中 12.546%，5 次用量未知。根因证据是首条 system 中执行状态在 112 组相邻请求变化；该任务没有摘要调用或工具 Schema 变化。

## 已完成

- application：新增执行状态追加日志，原文、锚点、完整基线与增量持久化。压缩状态基线后补最新完整状态；只读历史可按来源查阅这些程序观察。
- adapters：Chat Completions / Responses 工具名称和 Schema 对象键稳定排序，保留数组、调用配对及私有续接原序。
- state：可选 executionNotes/previewLimits，保证恢复后状态不重复注入、工具预览不膨胀；无需数据库迁移。
- observability/contracts/Web：缓存输入与已知输入分开累计，显示加权命中率及未知请求数；旧匿名汇总未知，不补零。
- 新增不联网的 `pnpm test:cache:replay <主 Run ID>`，只读已有 Chat Completions 原始材料，以当前 ContextService 在内存库重建输入。凭证不读取，正文不输出。

## 验证

- 离线真实轨迹：129 份已保存请求全部重放，123 组同 Run 相邻输入从 11 组完整前缀保留提升为 123 组；system 改写从 112 到 0；工具集合变化 0；摘要/网络调用 0。结果在 `.cache/cache-replay.log`。
- 该对照使用固定历史轨迹，不模拟模型后续行为，不是优化后 KV 命中实测。优化后实际命中率等待用户后续任务的服务商 usage。
- 上下文专项 32 项通过：双协议真实本地 HTTP、增量/压缩基线、恢复、最新工具批次、预览、取消、来源查询和工具序列化。
- `pnpm verify`：367 项通过，14 项独立原生用例按配置跳过；架构、文档、类型、构建及产物边界检查通过。日志 `.cache/cache-verify.log`。既有 lint 警告与前端大 chunk 提示仍存在。
- `pnpm test:e2e`：31 项通过，含缓存命中、草稿保持、双协议工具、团队及上下文流程；日志 `.cache/cache-e2e.log`。补充观测页 4 项独立验证通过，包含 390px 窄屏；截图 `.cache/acceptance/cache-metrics-desktop.png`、`cache-metrics-mobile.png` 已检查。独立执行时发现测试漏填必需 systemPrompt，已修正初始化并断言保存成功；不是产品缓存故障。
- 本机 3000 已更新：保留 8 个会话、模型配置哈希一致；模型调用总数前后均为 272，没有自动重跑。停服完整备份位于数据目录的 `backups/before-cache-fix-20260929-142653`，数据库 v13 且 integrity_check=ok；脱敏核对 `.cache/cache-local-verification.json`。
- 没有新增真实模型调用；本轮未改原生执行、数据库版本或容器装配，未重复原生/Docker 验收。没有提交、推送或公共部署。

## 知识与边界

根及 application/adapters/state/observability/Web/tests/scripts 约定已检查。新增 [ADR-0019](../adr/0019-cache-stable-context.md)，同步上下文与观测协议、维护入口。模块依赖保持不变。没有恢复任务总时限或累计产出上限，没有自动重试失败任务；缓存由服务商控制，不能保证百分之百命中。
