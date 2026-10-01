# ADR-0019：稳定请求前缀与追加执行状态

日期：2026-09-29；状态：已实施。

## 问题与依据

一次长团队任务 129 次实际请求中，已知输入 5,306,189 token，缓存读取 665,728 token，实际命中约 12.55%；5 次请求缺少 usage。123 组同 Run 相邻请求有 112 组修改了首条 system，来自执行事实索引变化；工具目录在该轨迹中没有变化。容量压缩与累计 token 统计本身不等于服务商缓存失效原因。

参考只读 Codex 快照 `5ecb3afd1bf405149e2159bfda50093b0c1b5fab` 的 `codex-rs/core/src/context_manager/history.rs::update_world_state`：环境状态变化作为快照或增量追加，保留持久基线。`core/src/client.rs` 还传递稳定会话缓存键；缓存键并不能替代相同前缀。

[OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching) 和 [DeepSeek 上下文缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/) 都要求稳定的共有前缀。[DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/) 不采用客户端的 prompt_cache_key/retention 控制。本轮不向所有兼容接口盲目添加这些参数，也不为预热重复调用模型。

## 决定

1. 固定指令、规则和记忆维持原 Run 快照。执行状态通过 `ExecutionContextJournal` 按已完成消息的来源锚点追加，正文和引用事务保存；相同状态去重。
2. 首条状态为完整有界索引，后续按身份生成变化：标量替换、条目 upsert、移出索引。移出索引不代表副作用撤销。增量比完整索引更长时发送完整索引。旧内容不原地更新。
3. 状态链经过压缩后，重新追加最新完整快照，不依赖摘要重建真实状态。最新业务批次优先保留，尾部状态记录不能使它提前被摘要。取消、删除、generation 变化仍拒绝迟到提交；权限核验仍查询执行仓储。
4. 双协议工具定义按名称、Schema 对象键确定性序列化；数组与 Responses 私有 Item 顺序保持原样。真实增加、删除或更新工具仍正常生效。
5. 工具预览的缩减上限按来源保存于 Run，后续不重新膨胀；原始历史与结果文件不变。
6. 页面用服务商实际 cacheReadTokens / 已知缓存字段的 inputTokens 求加权命中率，缺失字段单列未知。不会用离线相同前缀比例冒充缓存命中或账单节省。

## 边界与代价

- 不新建 Agent 循环，不限制任务轮数、累计产出或总时长，不强制减少自主分工。
- 压缩、Skill 加载、工具集合改变、记忆撤销及连接切换仍可改变输入前缀；不能为缓存保留失效授权或旧知识。
- 状态增量仍消耗上下文，因此参与普通压缩。正文是背景 user 消息，不伪造模型推理、工具回执或用户执行授权。
- SQLite 保持 v13；ContextRunRecord/UsageSummary 增加兼容可选字段，旧记录不伪造状态或命中。既有正在恢复任务第一次进入新布局可能重建一次前缀。
- 未修改价格表，也不追溯重新计价已有调用；官方别名/自定义接口未匹配价格时仍可配置手动单价。

验证与脱敏证据见 [本轮记录](../history/2026-09-29-cache-prefix.md)。
