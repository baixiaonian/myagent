# 上下文协议与 SQLite v6

数据库版本与 SSE 事件版本分别管理；本次数据库 v6，新增 context.updated 事件采用 schemaVersion=4，SDK 保持读取历史 v1/v2/v3。原聊天、工具、审批协议继续适用。

## 设置与读取

GET/PUT `/api/v1/settings` 增加可选 contextWindowTokens、outputReserveTokens。省略时保留已有值，旧配置读取时缺省 200000/4096。字段必须为正整数；扣除预留和安全余量后输入至少 1024。密钥边界不变。

GET `/api/v1/sessions/:id/context` 返回 ContextView 或 null。包含状态、容量估算、分类明细、摘要/来源 ID、规则路径与哈希、压缩请求数、摘要用量与总用量。摘要内容不进入聊天正文；不返回原始续接。总用量在决策用量或摘要用量未知时为 null。

GET `/api/v1/sessions/:id/history` 支持 query、sourceId、cursor、limit、includeSuperseded。查询参数以 URL 字符串传输，严格校验后显式转换；limit 为 1–20，includeSuperseded 为 true/false。响应每页正文最多 8000 字符；nextCursor=null 表示结束。游标绑定会话与查询，不能跨作用域复用。

同名能力通过只读工具 read_conversation_history 暴露给模型；工具不接受 sessionId。结果里的来源记录、调用结果和候选回答分支状态有各自含义，不能把旧工具成功等同于该候选回答仍然生效。

## 暂停与恢复

新增 RunStatus=waiting_context，属于活动状态；SQLite 单活动 Run 索引包含它。界面允许停止，禁止同时启动第二个 Run。

POST `/api/v1/runs/:id/resume` 保留空 body 的旧执行恢复行为；上下文暂停需要：

```json
{"requestId":"调用方生成的唯一标识","contextAction":"retry"}
```

contextAction 可为 retry 或 apply_capacity。后者仅复制最新窗口和输出预留；原模型、地址、协议、规则、凭证和单次调用超时配置不改变。相同标识重发返回原状态，不重复增加摘要 generation；同标识不同动作返回冲突。

可见状态 ready / compacting / warning / blocked / interrupted；错误包括 context_base_too_large、context_limit、context_summary_input/size/invalid/timeout、provider_context_limit。原始厂商错误体不进入日志和响应。

## 持久化

当前 v13 上兼容增加 ContextRunRecord.executionNotes（状态记录 ID/消息锚点）和 previewLimits（各来源预览上限）。状态 artifacts 只保存程序观察的正文、基线和增量，不含模型私有续接；历史 API 增加 kind=context，可按来源分页读取安全正文。旧检查点缺省为空，不补造过去已发送的请求。无需数据库/SSE 版本变更。

context_records 使用固定集合 runs / summaries / jobs / manifests / artifacts，按会话/Run 外键删除。摘要记录包含 templateVersion、来源指纹、identity、instructionsHash、published；草稿不等于已发布摘要。来源/工具快照按哈希复用，请求清单保存选入来源、投影、摘要引用和最终消息哈希。

v5→v6 只建表和更新活动 Run 索引。旧消息不补造 Step，旧历史不补造摘要，启动不调用模型。旧 Run 恢复保留连接与活动时间统计；旧总时限/累计输出字段忽略；没有旧根规则快照时不注入后来出现的文件，旧步骤来源从已存 Step 恢复；显式上下文字符预算（非累计产出）作为兼容上限，新默认路径改用容量设置。未来版本数据库由旧代码拒绝打开。

结果引用新增兼容字段 captureReason、omittedBytes：完整采集为 complete/0，不完整为 capture_incomplete/null（不知道省略总量）；bytes/totalBytes 为实际保存大小。模型文本的 truncated 是另一层投影状态。

工具预览采用首尾保留：单条默认 8000 字符，超限输出合法 JSON，preview 中间带截断说明与 read_tool_result 引用，execution 单独保留执行事实。字符预算按最终序列化字符串长度计量；上下文紧张时从已保存原文重新生成较小视图，来源及调用配对不变。固定信息无法容纳时返回 context_limit 并进入 waiting_context，不重新执行工具。旧的仅头部预览存在有效结果引用时可从原文件恢复首尾；无文件的旧消息不伪造丢失内容。本轮没有数据库迁移或 SSE 版本变更。

## 摘要弹性预算与完整用量

摘要写作目标最多2048估算token，发布上限 min(8192, 可用输入预算×30%)；分块及压缩范围选择按发布上限预留。略超写作目标不取消流，收齐正常终态、usage 后校验内容非空/无工具/确实缩小/上限与整体容量，允许完整摘要在弹性空间内发布。拒绝过大或无效摘要时保留原有效上下文和实际用量，不将半份正文发布，也不自动再请求模型。异常响应采集上限 max(32768, 发布上限×4) 估算token，独立于任务累计产出。模板v2不使原有效v1摘要失效；数据库仍v13。


## 完整窗口的 Web 投影（2026-09-30）

ContextView 增加兼容可选字段 `capacity: { contextWindowTokens, outputReserveTokens }`，来源为该 Run 已有检查点；修改全局设置不改变旧视图。百分比为 `estimatedTokens / capacity.contextWindowTokens`，可用输入预算仍单独展示，不能将扣过预留的 inputBudget 称为完整窗口。旧服务缺少容量或 stats 未准备时显示未知/待估算，不补造零值；历史数据不迁移。
