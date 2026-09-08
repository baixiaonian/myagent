# 协议目录

当前实现 [本地 Web Chat API v1](chat-v1.md)。类型公共入口为 `packages/contracts/src/index.ts`，客户端封装为 SDK。

工具、Policy、Execution、插件 SPI、RunCommandPort 的 steer / resume / followUp 等仍是设计预留，尚无可调用 API。新增能力必须版本化文档、迁移和契约测试。
