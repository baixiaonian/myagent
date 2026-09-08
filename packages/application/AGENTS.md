# 聊天用例

继承 [包约定](../AGENTS.md)。通过 state 契约持久化，modelFactory 由 server 注入，不导入 SQLite、HTTP 或厂商 SDK。

同 requestId 的重复请求必须返回原 Run，不再调用模型；冲突请求明确报错。创建消息和 Run 是单事务。增量先持久化后推送，终态立即提交。重新生成成功才替换原回答。删除会话必须取消执行，迟到结果不得复活数据。设置每次运行快照化。任何自动重试或恢复付费调用都需要新的产品设计。

更新 [状态协议](../../docs/protocols/chat-v1.md) 与相关集成测试，保持 STATUS / history 同步。
