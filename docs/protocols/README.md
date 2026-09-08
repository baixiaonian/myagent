# 协议目录

当前只记录设计位置和关键语义，不声明已存在可调用 API。

| 协议 | 计划定义位置 | 必须明确 |
| --- | --- | --- |
| RunCommandPort / 命令 DTO | contracts/commands | start / steer / followUp / cancel / resume，幂等与 revision |
| RunEvent | contracts/events | schemaVersion、sessionId、runId、seq、eventId，重连 watermark |
| 消息与模型流 | contracts/messages + kernel/model | 完整工具参数、attempt、停止原因和 usage |
| Tool / Policy / Execution | contracts/tools + kernel 对应目录 | Schema、参数摘要、授权范围、deadline、回执 |
| StatePort / ContentPort | kernel/ports | 状态事务、版本和大内容引用 |
| 插件 SPI | extensions | API 版本、依赖、activate / dispose、权限上限 |

实现第一个纵向闭环时再冻结最小接口；协议变更同步文档、版本和契约测试。路线见 [下一步](../roadmap.md)。
