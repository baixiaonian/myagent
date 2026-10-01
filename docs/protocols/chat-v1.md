# 本地 Chat / Agent API v1

工具执行扩展见 [执行协议 v3](execution-v3.md)，以下基础聊天接口继续兼容。

生产同源 `/api/v1`，默认本机 3000。JSON 命令必须使用 `Content-Type: application/json`，无参数 POST 也提交 `{}`；DELETE 无正文。错误统一 `{ "error": { "code": "...", "message": "安全中文提示" } }`，不返回上游异常正文。请求体上限 64 KiB。

模型 HTTP 402 返回 `model_payment_required`（上游余额不足或计费受限），与 `model_rate_limit`、普通 `model_request` 及明确容量错误 `provider_context_limit` 区分。使用固定中文提示，不回显上游正文、不自动重试。HTTP API 使用 502 表示上游调用失败；Run.error 和设置连接测试使用相同映射，旧失败记录不追溯改写。

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| GET /settings | PublicSettings：apiProtocol、baseUrl、model、systemPrompt、revision、updatedAt、hasKey、keyMask、configured |
| PUT /settings | baseUrl、model、systemPrompt、expectedRevision；可选 apiProtocol、apiKey 或 clearKey；返回脱敏 PublicSettings |
| POST /settings/test | 同更新格式，使用当前保存密钥或本次新输入；单次实际简短请求，成功 `{ok:true}`，不保存设置或历史 |
| GET /sessions | `{sessions: Session[]}`，按 updatedAt 倒序 |
| POST /sessions | `{}`，201 返回 Session |
| GET /sessions/:id | SessionSnapshot |
| PATCH /sessions/:id | title、expectedRevision，返回 Session |
| DELETE /sessions/:id | 204；先取消活动运行，级联删除 |
| POST /sessions/:id/runs | requestId、expectedRevision、content；202 `{run,snapshot}` |
| POST /sessions/:id/regenerate | requestId、expectedRevision、可选 confirmSideEffects；202 `{run,snapshot}` |
| POST /runs/:id/cancel | `{}`，返回终态或已有终态 Run；重复停止无副作用 |
| GET /sessions/:id/events?after=N | SSE；支持 Last-Event-ID 优先于 query，按会话有序补读 |

## 状态与并发

Session 含 id/title/revision/createdAt/updatedAt。Message 含 id/sessionId/runId/role/content/status/replyToId/createdAt。Run 记录原问题、候选回答、原回答、kind、requestId、请求指纹、模型名、apiProtocol、stepCount、裁剪标志、状态、终结原因、usage、错误和时间。旧 Run 可以缺少协议和步骤数。Run 不保存密钥；请求指纹仅用于幂等，包含命令种类、问题、期望版本。

Snapshot 为 `{session,messages,latestRun,activeRun,steps,cursor}`，同一事务读取。steps 是按 Run / index 有序的公开执行过程；SDK 同时兼容缺少 steps 的旧快照。cursor 是会话事件最大 seq。Run 包含 running、waiting_approval、waiting_reconciliation、recoverable、cleaning 活动态 → succeeded / cancelled / failed / interrupted；终态不再追加。Message：generating → completed / cancelled / failed / interrupted，成功被替换的旧答案为 superseded。成功表示循环正常结束，不表示经过额外任务质量评估。

Step 含 id/runId/index/status/content/tools/finishReason/usage/error/createdAt/endedAt。status 为 model / tools / completed / failed / cancelled / interrupted；tools 含调用 id/name/arguments、pending / running / succeeded / failed / cancelled / interrupted 状态及结果。结果包含 callId、ok、data、error、modelContent、truncated。v3 完整结果单独保存，data 是有界公开视图并可带 resultRef；模型仅接收受限的 modelContent。每个 Step 保存实际 usage；Run 只有全部 Step 用量已知时才提供累计，否则为 null。

每次模型输出独立记录；模型返回工具的文字进入过程，最终无工具输出进入回答。正在流式输出时尚不知道是否带工具，因此先显示当前文字，收到完整响应后再归入过程。重新生成新建独立候选 Run；成功替换原答，失败保留原答及其计划。计划仅从当前 Run 成功的 update_plan 工具结果投影，不存在另一个可写计划事实源。

requestId 应由客户端生成并在不确定结果时复用。相同 requestId + 相同内容 / kind / revision 返回同一 Run，先于 revision 检查；不同负载 409 idempotency_conflict；已有活动 Run 409 run_active；陈旧 revision 409 revision_conflict。冲突后读最新快照再决定新请求。只有连接不确定时保留原幂等标识，SDK 不自动重发命令。

## SSE

新事件为 `{schemaVersion:3,sessionId,seq,createdAt,...payload}`，历史 v1/v2 原样保留，SDK 同时兼容。`id:` 与 seq 相同；默认 `data:` 为 JSON，类型有 session.updated、message.created、message.updated、message.delta、run.updated，以及 step.updated（完整 step）、step.delta（stepId/delta）。状态与事件同事务提交。文字约 250ms 合并，工具执行前先提交调用，结果提交后才进行下次模型请求；终态以完整更新校准内容。SDK 对 seq ≤ 当前游标去重，跳号触发重新读取快照。EventSource 断线自动重连，Last-Event-ID 补读；每 15 秒 heartbeat，每 250ms 查新事件，每批最多 1000 条。

deleted / unavailable 为命名控制事件，客户端分别移出已删除会话或刷新快照。非法游标返回 400；会话不存在返回 404。SSE 断开仅关闭订阅，不取消 Run。

## 存储版本

SQLite `user_version=3`：[0001_chat.sql](../../migrations/0001_chat.sql) 为聊天基线，[0002_agent.sql](../../migrations/0002_agent.sql) 增加 run_steps（run_id/index 唯一，Run 外键级联）。升级不伪造旧聊天 Step；旧消息继续正常展示。settings 保存非敏感配置和 credentialRef；独立 credentials.json 保存 UUID→密钥映射。messages/runs/events/run_steps 随会话级联删除，runs 保持会话内 requestId 唯一键和单活动 Run 唯一索引（含等待状态）。

run_steps 保存公开 step 与仅服务端使用的 identity/continuation。identity 绑定协议、规范化基础地址和模型，不含密钥。同连接成功完整历史保留执行链；切换连接时旧轮次仅用用户问题和最终回答。不把推理/加密续接 Item 放进公开 Step、SSE、回答或普通日志。重启有检查点的 Run 核对回执后等待手动继续；无检查点的旧 Run 标 interrupted，绝不自动重放动作。

## 双模型协议与最小端口

apiProtocol 为 responses / chat_completions；新界面默认 Responses，已有连接缺字段解释为 Chat Completions，省略更新值保留原协议。每个 Run 使用设置与资源配置快照，连接测试使用选定协议作一次无工具请求。错误不触发探测、协议回退或自动重试。

ModelPort 提供文字增量、额外输出计量、完整响应（文字、工具调用、私有续接）、结束原因及可选用量。Responses 每次 store:false 并发送完整本地输入，保留原序 output Item 和必要 reasoning 字段；不使用 previous_response_id、Conversations 或托管工具。Chat Completions 聚合 tool_calls 分片，通过 assistant/tool 消息按 ID 反馈，并保留已有 reasoning_content。

ToolExecutor 由 Server 注入，执行器在执行前依据同一 JSON Schema 做最终参数校验。update_plan 接受完整 steps 列表和可选 explanation；get_current_time 接受可选 timezone（IANA，默认 UTC）。未知工具、参数及可恢复执行错误返回工具结果；模型决定继续或修正。缺失/重复 ID、截断、未完成协议、模型错误、取消或容量超限终止循环。ContextBuilder 每次请求前按完整历史轮次裁剪，保留本轮链，无法容纳时返回 context_limit。端口详情及资源默认值见 [自主循环](../architecture/agent-loop.md)。

[核心类型](../../packages/contracts/src/index.ts) · [Agent 类型](../../packages/contracts/src/agent.ts) · [HTTP 校验](../../apps/server/src/routes/schemas.ts) · [协议集成测试](../../tests/agent/integration.test.ts)

## Web 展示投影

侧栏结合既有会话列表与完整 `GET /api/v1/workspaces` 数据，按规范项目路径显示项目下的会话。不能仅依赖有数量上限的最近项目清单，不能以显示分组改变 `workspaceId`。默认目录及未绑定记录保留独立入口。项目内新建只准备目录，不改变创建幂等协议。

用户问题使用右侧气泡，助手正文采用连续文档排版；工具步骤的中间文字与对应工具批次按原顺序交错展示。工具批次默认折叠，参数及结果进一步展开；最终回答继续来自原 assistant 消息，不合并/改写 Step 或服务端续接数据。状态、计划、审批和恢复只消费既有公开事实。本轮不增加 API 或事件版本。


### 工作台展示补充（2026-09-30）

工具过程按 Run 聚合：运行中默认展开，终态收起一次，最终答案保持独立；异常计数仍可见，展开后保留 Step 顺序、中间说明和原文分页。团队在右栏，收起仅改变展示；审批在输入区或对应成员详情中，授权范围按审批 ID 隔离，命令仍只支持 once。设置统一导航，不创建空会话，主要表单切页保护未保存输入。上下文占比由 ContextView 冻结窗口计算，不能将累计 usage 当作当前窗口用量。
