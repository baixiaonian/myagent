# ADR-0004：单一自主循环与双模型协议

日期：2026-09-12；状态：已采纳。扩展 ADR-0003 的零工具限制，保留本机单用户与模块化单体。

## 决策

采用长期稳定的模型驱动工具循环，复杂任务策略交给模型。计划作为普通可选工具，不引入固定 Planner/Executor 调度，不强制反思，不以计划状态替代模型结束或任务验收。

ModelPort 下实现 Responses 和 Chat Completions，使用现有 OpenAI SDK 7.10.0。新设置界面优先 Responses；旧数据库/旧客户端省略字段时保留 Chat Completions。协议变化从下一次运行生效，不自动探测或失败回退，以避免隐含重复请求。

上下文由本地记录构建；Responses 使用无状态 Item 重放，兼容 DeepSeek 不支持 previous_response_id 的实现。续接材料是服务端私有数据，绑定连接身份；换连接时历史降为最终问答，不透传旧的专有材料。

工具用同一 JSON Schema 描述和校验，Ajv 8.20.0 只声明于 adapters。许可证 MIT，无安装脚本，Node 运行通过本轮测试验证。内核不引入框架、数据库、厂商 SDK 或 Node API。

## 后果与替代方案

双协议增加适配器测试量，但不增加两套业务循环。工具暂时串行，限制在注册的计划和时间工具；高级执行和内容系统后续替换端口实现。没有每轮额外规划/反思模型成本。

不采用服务端 Conversation 作为状态权威，因为会让恢复、换服务商与审计依赖远程会话。不采用框架规定的步骤调度，因为模型应自行选择工作方法。时间与容量限制是运行资源边界，不是思考流程。

新 Step 记录需要 SQLite v2 和事件 v2；升级保持旧消息及事件，SDK 接受历史 v1。回退旧程序前必须恢复升级前的完整数据备份。真实模型仍需单独授权验收，假模型只能证明工程协议。

依据：[Responses 迁移说明](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)、[DeepSeek 思考续接](https://api-docs.deepseek.com/guides/thinking_mode/)。
