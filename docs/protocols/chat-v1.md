# 本地 Chat API v1

生产同源 `/api/v1`，默认本机 3000。JSON 命令必须使用 `Content-Type: application/json`，无参数 POST 也提交 `{}`；DELETE 无正文。错误统一 `{ "error": { "code": "...", "message": "安全中文提示" } }`，不返回上游异常正文。请求体上限 64 KiB。

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| GET /settings | PublicSettings：baseUrl、model、systemPrompt、revision、updatedAt、hasKey、keyMask、configured |
| PUT /settings | baseUrl、model、systemPrompt、expectedRevision；可选 apiKey 或 clearKey；返回脱敏 PublicSettings |
| POST /settings/test | 同更新格式，使用当前保存密钥或本次新输入；单次实际简短请求，成功 `{ok:true}`，不保存设置或历史 |
| GET /sessions | `{sessions: Session[]}`，按 updatedAt 倒序 |
| POST /sessions | `{}`，201 返回 Session |
| GET /sessions/:id | SessionSnapshot |
| PATCH /sessions/:id | title、expectedRevision，返回 Session |
| DELETE /sessions/:id | 204；先取消活动运行，级联删除 |
| POST /sessions/:id/runs | requestId、expectedRevision、content；202 `{run,snapshot}` |
| POST /sessions/:id/regenerate | requestId、expectedRevision；202 `{run,snapshot}` |
| POST /runs/:id/cancel | `{}`，返回终态或已有终态 Run；重复停止无副作用 |
| GET /sessions/:id/events?after=N | SSE；支持 Last-Event-ID 优先于 query，按会话有序补读 |

## 状态与并发

Session 含 id/title/revision/createdAt/updatedAt。Message 含 id/sessionId/runId/role/content/status/replyToId/createdAt。Run 记录原问题、候选回答、原回答、kind、requestId、请求指纹、模型名、裁剪标志、状态、终结原因、usage、错误和时间。Run 不保存密钥；请求指纹仅用于幂等，包含命令种类、问题、期望版本。

Snapshot 为 `{session,messages,latestRun,activeRun,cursor}`，同一事务读取。cursor 是会话事件最大 seq。Run：running → succeeded / cancelled / failed / interrupted；终态不再追加。Message：generating → completed / cancelled / failed / interrupted，成功被替换的旧答案为 superseded。

requestId 应由客户端生成并在不确定结果时复用。相同 requestId + 相同内容 / kind / revision 返回同一 Run，先于 revision 检查；不同负载 409 idempotency_conflict；已有活动 Run 409 run_active；陈旧 revision 409 revision_conflict。冲突后读最新快照再决定新请求。只有连接不确定时保留原幂等标识，SDK 不自动重发命令。

## SSE

事件为 `{schemaVersion:1,sessionId,seq,createdAt,...payload}`。`id:` 与 seq 相同；默认 `data:` 为 JSON，类型有 session.updated、message.created、message.updated、message.delta、run.updated。每条事件先持久化，终态以完整 message.updated 校准内容。SDK 对 seq ≤ 当前游标去重，跳号触发重新读取快照。EventSource 断线自动重连，Last-Event-ID 补读；每 15 秒 heartbeat，每 250ms 查新事件，每批最多 1000 条。

deleted / unavailable 为命名控制事件，客户端分别移出已删除会话或刷新快照。非法游标返回 400；会话不存在返回 404。SSE 断开仅关闭订阅，不取消 Run。

## 存储版本

SQLite `user_version=1`，迁移为 [0001_chat.sql](../../migrations/0001_chat.sql)。settings 保存非敏感配置和 credentialRef；独立 credentials.json 保存 UUID→密钥映射。messages/runs/events 随会话级联删除，runs 有会话内 requestId 唯一键和单 running 唯一索引。事件不执行回放动作。

[核心类型](../../packages/contracts/src/index.ts) · [HTTP 校验](../../apps/server/src/routes/schemas.ts) · [测试](../../tests/chat/integration.test.ts)
