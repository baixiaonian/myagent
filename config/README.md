# 配置

本目录的 YAML 使用中文注释说明作用；严格 JSON 保持合法格式，不插入注释。`modules.json` 定义模块职责、实现状态与允许依赖，供架构检查读取；`plugins.lock.json` 是尚未启用的插件锁定清单骨架。实际启用和迁移情况以本文及架构文档为准。

`modules.json` 是当前工程检查使用的模块清单，维护允许依赖与聊天 v1 / 骨架状态。
`defaults.yaml`、`profiles/`、`plugins.lock.json` 是目标位置，尚无运行时加载器。
策略优先级、密钥引用和配置快照见 [架构概览](../docs/architecture/overview.md)。
不要在配置中保存实际令牌。新增运行时配置时定义 Schema、默认值、覆盖规则和迁移方式。

当前实际运行配置通过 Web 设置保存在 SQLite；启动变量为 MYAGENT_DATA_DIR、PORT、MYAGENT_WEB_PORT，详见 [维护说明](../docs/development/setup.md)。
