# 工具执行协议 v3

HTTP 路径继续使用 `/api/v1`；v3 指持久化和事件版本，不是新建第二套 API。基础聊天协议见 [chat-v1](chat-v1.md)，架构及保证边界见 [工具执行系统](../architecture/tool-execution.md)。

## 新增接口

| 方法与路径 | 输入和用途 |
| --- | --- |
| GET /workspaces | 已创建工作区 |
| POST /workspaces | path、name；规范化并校验已存在目录，返回 Workspace |
| PUT /sessions/:id/workspace | workspaceId、expectedRevision；绑定后不可更换 |
| GET /sessions/:id/execution | workspace、approvals、invocations、processes、concerns |
| GET /workspaces/:id/grants | 工作区授权记录，包含撤销时间 |
| DELETE /grants/:id | 撤销授权并收拢相应执行环境 |
| POST /approvals/:id/decision | requestId、decision=allow/deny、scope=once/session/workspace；已决定请求校验幂等，必要时继续原 Run |
| POST /runs/:id/resume | `{}`；人工继续检查点，未解决审批/未知结果返回 409 |
| POST /invocations/:id/resolve | kind、note；由服务端添加核对时间，适用于普通调用或会话删除后的隔离记录 |
| GET /sessions/:id/results/:resultId?cursor= | 同会话受控结果分页，最多 8,000 字符，返回 text/cursor/captureComplete |
| GET /mcp/connections | 脱敏配置，不返回密钥或凭证引用 |
| POST /mcp/connections | 创建配置，不启动外部程序 |
| PUT /mcp/connections/:id | 更新配置含 expectedRevision，关闭旧连接 |
| POST /mcp/connections/:id/connect | workspaceId；连接、发现目录，必要时返回 authorizationUrl |
| DELETE /mcp/connections/:id | 删除本地凭证，返回 localRemoved 与远端 OAuth 撤销结果 |
| GET /mcp/oauth/callback | 一次性 state/code，只用于浏览器 OAuth 返回，不回显认证材料 |

MCP 输入类型见 [execution.ts](../../packages/contracts/src/execution.ts)。stdio args 是参数数组，环境变量值独立提交；禁止覆盖 PATH/HOME、加载器和代理变量。HTTP 认证 none/token/oauth，模型生成参数不能修改连接配置。

## 状态、版本和私有材料

活动 Run 状态包含 running / waiting_approval / waiting_reconciliation / recoverable / cleaning，同会话单活动索引覆盖全部这些状态。终态为 succeeded / failed / cancelled / interrupted。cancel 请求可能返回仍待核对的状态，不能把未确认停止伪装为取消成功。`confirmSideEffects:true` 用于带副作用问题重新运行确认，并进入请求幂等指纹。

新事件 `schemaVersion:3`；SDK 接受历史 v1/v2。新增 `execution.updated {runId}` 提示重新读取执行事实。seq 同事务单调递增。Step 保留既有显示结构，v3 工具状态从 invocation 投影；旧记录没有 invocation 时显示原 Step。快照不含设置检查点、模型 reasoning 续接或 OAuth 凭证。

SQLite `user_version=3`，升级路径为 0001_chat → 0002_agent → [0003_tools.sql](../../migrations/0003_tools.sql)。新增 sessions.workspace_id，更新活动索引，新增 `execution_records`。固定集合为 workspaces、grants、approvals、invocations、attempts、processes、results、connections、checkpoints、concerns。应用使用类型化仓储；数据 JSON 不表示任意可执行脚本。

有 session/run 归属的记录通过外键级联删除。concerns 使用 sourceSessionId 保存来源标识，没有会话外键，避免删除聊天绕过未知结果隔离。普通 put 拒绝终态 Run 的迟到写入；用户核对走独立 resolveInvocation，仅更新核对结论，不把原 unknown 改成 succeeded。

checkpoints 保存启动设置引用、上下文、当前模型响应、工具批次、活动时间及已加载目录。continuation 仍绑定协议、接口地址和模型，只有服务端模型适配器读取。凭证本身不入 SQLite；结果正文在 results/，Worker intent/receipt/process/output 在 execution/。恢复读取这些本地事实，绝不靠 requestId 猜测远端幂等。

当前 v4 对检查点增加版本绑定并在 sessionTools 保存会话级选择，旧名称字段仅兼容投影；扩展语义与旧数据默认行为见 [项目/MCP v4](projects-mcp-v4.md#按需选择的会话持久化)。不改变原执行事实、审批及未知结果的所有权。

## 错误和恢复

`process_resource_busy` 表示本次工具尚未派发：同 Run 已返回句柄的进程持有所需资源。结果包含进程 ID，模型可调用 read_process / stop_process 再决定是否重新请求；旧调用结果仍幂等返回，不能自动重试。普通工具与 Hook 使用同一保留锁检查。其他 Run 等待真实资源锁，超过 5 秒返回 resource_busy；不能因为长进程阻塞而提前释放。数据库/事件版本不变。

unknown_tool / invalid_tool_arguments / permission_denied / approval_denied / file_conflict 作为准确的工具错误反馈模型。sandbox_unavailable 表示未取得执行隔离。result_unknown / process_unknown / execution_storage 需要核对，不自动重放。恢复时先读取可信回执，缺失回执的已接受副作用操作保持 unknown；人工判断有独立来源说明。

停止服务后备份整个数据目录，包含 credentials.json、数据库、results/ 和 execution/，工作区文件另行备份。不能仅恢复 SQLite 而丢失结果及凭证，也不能用旧版本代码直接打开 v3 数据库；回退要恢复升级前的完整备份。

大结果的 modelContent 默认最多 8000 字符：保留原文头尾，中间标明截断及补读引用；执行状态、错误、进程退出码独立保留。截断后的文本为合法 JSON，预算包含转义及附加信息。Worker 命令快照的 output 最多 6000 字符，新增兼容字段 outputTruncated；它不改变 outputComplete 的采集完整性含义。read_process 和 read_tool_result 仍按游标读取原文。结果文件不可用时明确报错，不把旧预览称作完整结果。

## 只读执行与可诊断等待（v13 兼容扩展）

exec_command 增加可选 readOnly:boolean。标准模式未指定时只对可信程序及静态读取参数自动分类；显式 false 或无法确认时保持原排他执行。完全访问不自动分类，显式 true 则使用只读沙箱。此模式只允许 cwd 和 additionalPaths 中的 read 目录，不接受网络或 write 扩展；不能将其当作无约束的 Shell。cwd 默认项目根，可选具体子目录缩小读取和共享锁范围。普通命令仍占项目写锁。

资源锁排队上限 5 秒，仅使未派发的调用返回 resource_busy，不终止 Run 或持锁进程；错误和 tool.lock_blocked 事件包含 Run、invocation、工具、进程与资源。进程结束前不释放锁，控制工具保持可用且同批按顺序执行。字段错误返回具体约束和纠正方法，不返回参数正文。无数据库迁移/事件版本变化。
