# 团队协作协议 · SQLite v11 / SSE v6

## 版本与迁移

`0011_teams.sql` 增加内部会话父级关系、消息 origin、team_records，以及包含 `waiting_agents` 的单活动 Run 约束。已有普通聊天保持 parent 为空，不伪造成员或产生模型请求。启动核对后未完成范围 suspended，恢复必须由用户明确触发。旧程序拒绝打开 v11；回退必须恢复升级前的整库与数据目录备份。

team_records 按 kind 保存 scopes、members、links、messages、jobs、waits、seeds、heads、operations；数据库是唯一状态源。成员内部会话仍用原 messages/steps/invocation/results 仓储，不在团队记录中复制第二份执行历史。

## 工具

| 工具 | 参数要点 | 约束 |
| --- | --- | --- |
| spawn_agent | name、instructions、task、context: brief / recent(turns) / full | 仅主 Agent，返回 ID 不等待完成 |
| send_message | agentId（主 Agent 为 main）、kind: request / inform、content、replyTo、resultRefs | 服务端确定发送者，同团队，引用须有读取资格 |
| list_agents | 无 | 身份、任务、状态和结果入口 |
| wait_agents | agentIds、timeoutMs | 有界可取消；等待消息或指定成员变化，不占业务槽位 |
| read_agent_history | agentId、cursor | 最多 20 条、有界正文及续读；主 Agent 可读成员，成员只读自身/共享内容 |
| stop_agent | agentId、close | 仅主 Agent；停止工作或关闭身份，历史保留 |

实际参数的必需字段和上限以 `adapters/execution/team-tools.ts` 为准。调用 ID 是协作修改的幂等身份，变更参数复用旧 ID 返回冲突。非法参数、越界身份、已关闭成员、等待环以工具错误回传，模型可自行修正。

## 消息与共享

当前明确保留三种类型，不将普通回复与运行回执合并：

| 类型 | 生成方和用途 | 接收成员空闲时 |
| --- | --- | --- |
| request | Agent 发出处理请求，send_message 可选择 | 保存请求并启动新的成员 Run |
| inform | Agent 主动提供资料、进度或回复，send_message 可选择 | 保存，不启动模型请求 |
| result | 程序按真实运行状态生成回执，含状态、回答或错误，发给主 Agent 及对应请求方 | 保存，不启动新的成员 Run |

运行中的 Agent 在安全边界读取消息；waiting_agents 中收到消息可以继续。这里的空闲专指没有活动 Run 的成员，不能和等待中的 Run 混淆。result 不在 send_message 的可选 kind 中，模型不能用它伪造任务终态。

消息包含稳定 ID、单调序号、根会话/分支/主 Run、from/to、kind、content、replyTo、resultRefs、includedRunId/includedStep/repliedBy。内部 result 回执仅由服务端生成。入队不等于模型已阅读。

request 对空闲成员创建待启动任务；活动成员在完整工具批次后接收。inform/result 不唤醒空闲成员。回复关联必须属于可见消息。服务端将输入投影为有来源的背景消息，模型私有续接、授权、宿主凭证不传播。

模型协调结果默认最多 8,000 字符，必要时采用首尾预览及 `team:<invocationId>` 引用；完整控制结果仍持久化，可经 read_tool_result 查询。引用不能用于跨团队、跨分支任意读取。

## API 与 SSE

| 接口 | 返回/作用 |
| --- | --- |
| GET /api/v1/sessions/:id/team | 当前有效团队、成员运行状态与汇总用量 |
| GET /api/v1/sessions/:id/team/messages?cursor=… | 最近 20 条通信，before:sequence 向前分页 |
| GET /api/v1/sessions/:id/agents/:agentId/history?cursor=… | 成员安全历史投影，记录/字符偏移游标 |
| POST /api/v1/sessions/:id/agents/:agentId/stop | requestId、expectedRevision、可选 close；版本冲突不覆盖 |

团队变更发送 schemaVersion=6 的 team.updated 通知，详细内容按需查询，SDK 兼容旧 v1–v5。waiting_agents 是活动状态，前端发送/停止与单活动唯一约束必须使用公共 isActiveRun。内部会话不出现在普通列表，不接受外部直接发送新任务；审批、上下文恢复继续用既有受保护接口。

## 事务与预算

- 创建意图、成员、请求、协作回执同事务；任务维护器只启动已确认回执。
- 收件箱提交与当前 Run 检查点同事务，终态与完成消息同事务。
- 最终提交再次检查成员/请求，普通 no-tool 响应不越过未收拢工作。
- 全局模型 FIFO 含摘要，默认 4；默认 8 个未关闭成员；累计产出/耗时仅统计，不设团队总时限或字符额度；旧 scope.timeLimit/outputLimit 保留兼容读取但不再判断。等待审批/消息不持有模型名额或业务资源锁。
- 实际 usage 分 Run 记录并连同摘要累计；任一请求缺少用量则汇总为 null，不将估算当作计费数据。
- 重启不重放执行。等待/恢复保留原连接与版本；取消和删除后的迟到结果不能重新派发或注入。

## 等待的资源约束

wait_agents 是事件等待，timeoutMs 取 1–120000（默认30000）；到期可由模型再次决定等待。持有项目进程锁时返回 agent_wait_resource_conflict，要求先读/停已有进程，不能用 sleep 轮询成员产物。主任务候选收尾遇到同样冲突时注入执行状态继续处理，不先进入 waiting_agents。该约束不授予操作其他 Run 进程的权限。
