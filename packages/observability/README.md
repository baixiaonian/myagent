# observability

已接通观测 v1。纯端口、区间合并、价格快照与定点费用运算，仅依赖 contracts。

应用协调在 `packages/application/src/observability.ts`；文件、HTTP、SQLite 和 OpenTelemetry 在 adapters。Web 通过 SDK 查询，不读取原始文件路径。

入口：[架构](../../docs/architecture/observability.md)、[协议](../../docs/protocols/observability-v12.md)、[本模块约束](AGENTS.md)。
