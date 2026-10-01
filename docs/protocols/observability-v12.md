# 观测 v1 / SQLite v12

契约入口：`packages/contracts/src/observability.ts`；应用服务：`packages/application/src/observability.ts`。普通聊天事件保持 v1–v6 兼容，观测不通过聊天 SSE 发送。

UsageSummary 兼容增加可选 `cache: { readTokens, inputTokens, unknownRequests }`：前两个字段仅累计服务商返回合法缓存读数量的请求；无字段的旧匿名汇总全部记为缓存未知。命中率为 readTokens/inputTokens，不把未知请求当零命中；inputTokens=0 时没有可计算比例。无需数据库/SSE 升级。

## API

统一前缀 `/api/v1/observability`，复用现有 loopback、Host 与 Origin 校验。

| 路径 | 方法 | 内容 |
| --- | --- | --- |
| `/settings` | GET / PUT | debug、retentionDays、revision；读取含采集起始时间、缺损计数、导出与容量状态 |
| `/traces` | GET | sessionId、runId、rootRunId、model、status、purpose、from/to、offset/limit |
| `/traces/:id` | GET | spanOffset / eventOffset 分别分页，每类最多 200 条；Trace 含前段引用 |
| `/traces/:id/spans/:spanId/evidence` | GET | 按 Trace/Span 双重身份读取已有 Step、工具回执与团队消息；no-store，不含私有续接 |
| `/runs/:id` | GET | 主任务含成员的阶段耗时、实际用量、费用与 Trace ID |
| `/calls` | GET | 同一筛选口径下的模型调用分页；未发送意图也可排查，但不计作已发生请求 |
| `/calls/:id` | GET | 调用状态、usage、价格快照、费用和材料状态，不含原始正文 |
| `/calls/:callId/captures/:captureId` | GET | offset 字节游标，64 KiB 页面，UTF-8 边界续读；`download=1` 返回原字节 |
| 同上 | DELETE | 精确材料清理，requestId + expectedRevision（观测设置版本），活动采集拒绝清理 |
| `/usage` | GET | 同一筛选口径下总计、日期/模型/用途分组、按币种费用与未知数量 |
| `/prices` | GET / PUT | 官方条目与手工价格；手工保存绑定连接/模型、requestId、预期价格版本 |

设置 PUT 字段为 `{requestId, expectedRevision, debug, retentionDays}`。价格 PUT 使用 `{requestId, expectedRevision, price: {connection, model, currency, input, output, cacheRead, cacheWrite}}`；单价为每百万 token 十进制字符串，缓存 null 表示按普通输入价格计。新手工价格 expectedRevision=0。

原始材料读取校验 callId 与 captureId 归属，不能传文件路径。原始 API 设置 `Cache-Control: no-store` 和 `nosniff`；浏览器只以文本展示，不执行返回的 HTML。分页的 nextOffset 只表示尚有文件内容；是否采集完整由 capture.status 决定。

## 数据与恢复

`0012_observability.sql` 新增观测记录、设置和管理幂等表，kind 区分 traces / spans / events / calls / captures / prices / anonymous；按时间、会话、Run、调用、模型、用途与团队身份索引。原始正文只在文件库，不复制进 JSON 记录。

Trace / Span / Event 是诊断资料；calls 是长期用量账本。Run 原历史及执行回执仍由原仓储负责。业务执行不依赖 Trace 是否完整；账本持久化失败则停止新增付费调用。requestId 重复且内容不同返回冲突。

升级 v11→v12 不调用模型，不生成旧 Trace、旧原文或旧费用。新建设置记录 startedAt，页面明确显示采集起点。旧程序拒绝打开版本高于自身支持的数据库。

Trace 查询兼容新增可选 `task: {runId, status, error}`，来自主 Run 的实时投影；UI 按该身份归组，后台模型任务仍按 jobId 区分。审批与团队等待在同一进程内保留原 Trace，并用独立等待 Span 记录。

执行段中断后不自动重开旧 Span。新段建立新 Trace 和 Link；旧段只记最后观察时间，未知真实结束时间保持 null。正在采集的文件标为 partial/interrupted 并重算已保存字节；启动不重放网络请求。会话删除事务清除关联记录、转存匿名消耗，再删除无引用原始文件；启动清理遗留孤立文件。

## 原始数据边界的明确例外

原有“私有续接不进入 Web”继续适用于聊天、SSE、普通历史、结果和 Agent 可调用工具。新增例外仅限用户主动开启调试后，通过独立本机材料 API 查阅实际 HTTP 正文。加密推理只保存加密值，不解密；原始正文不声称已经脱敏。普通日志及 OTLP 不承载这一例外。


## Web 链路路由与查询（2026-09-29）

- `/traces/:traceId` 是独立 Web 页面；`?span=:spanId` 定位到右侧节点详情，支持刷新与浏览器历史。不是新增 API，服务端已有 SPA 回退继续适用。
- 聊天追踪入口与记录列表使用真实链接，在新标签打开以保留原聊天草稿及订阅。`/?view=observability` 可直接打开执行记录入口，不创建会话。
- 默认展示投影为任务 → Agent → Step → 上下文/模型/工具批次；分组不是新 Span，不修改持久父子关系。按明确 stepId/invocationId 归组，旧缺少身份的上下文不按时间猜测。异步成员独立分支，创建工具只计创建耗时，通过成员身份关联跳转。同任务恢复段独立分页并在同页归组，保留真实 Trace 身份和前段 Link。
- Span 和事件各按原 API 每页最多 200 条独立加载；搜索/异常筛选明确限定已加载节点并保留祖先。带节点链接按需补读所在页；轮询合并保留已加载后续页，后续页的活动节点也刷新。
- 选中模型节点后自动读取输入、输出首屏，同页展示属性、事件与 Link；上下文节点可展示所属步骤实际模型材料。原文仍走独立材料接口，不写入 URL、浏览器持久存储、普通 Trace DTO 或 OTLP。一键复制逐页读取已保存原文，采集不完整时注明片段；页面加载不全与采集缺损分开。
- 本轮不改变数据库、事件版本、Trace 收尾或计费口径。未知耗时不由墙钟补造；并行条共用起点，不将时长串行相加。

## Step 语义与上下文来源诊断

- Kernel 新增中立内部 `step.preparing` 事实，在目录快照/输入边界前通知应用开启观测 Step；它不创建业务 RunStep，不增加模型请求数，也不新增公开聊天事件。上下文准备、摘要与主模型请求显式传递 stepId / parentSpanId。
- 事件优先绑定显式父 Span，其次为对应 Step，最后才是 Run 根。摘要请求是 context.compact 的子节点，不作为新 Agent 决策 Step。
- ContextManifest 兼容新增 components：来源 ID、类别、标签、内容哈希、字符数。与上次同 Run 清单比较，记录 context.sources/added/changed/removed 与 prepared 容量明细；旧清单无字段时 baselineKnown=false，不把旧内容伪造成新增。每类事件最多 200 项并明确 omitted，完整来源清单仍在上下文仓储。只记录元数据，正文通过已采集的实际模型输入查阅。
- 正常权限/校验/派发隐藏在节点诊断详情；失败、拒绝、未知结果和至少 1 秒的锁/槽位/模型排队保留可见。内部诊断开关可展示全部已加载 Span。等待 0ms 不是执行权限不检查。
- SQLite 保持 v13，聊天 SSE 继续兼容 v1–v6；旧 Span、耗时、正文及上下文差异不回填。
