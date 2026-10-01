# 项目与 MCP 管理协议 v4

后续命令权限已将当前数据库升级至 v5，见 [命令协议与迁移](commands-v5.md)；本页保留项目/MCP v4 的字段与升级语义。

HTTP 仍使用 `/api/v1`。SQLite user_version 升至 4；聊天 SSE 继续使用 v3 事件，兼容 v1/v2，没有为管理页面建立第二套聊天状态机。

## 项目

| 接口 | 输入 / 返回 |
| --- | --- |
| GET /projects | 最近手动项目；默认会话目录不挤占最近项目列表 |
| POST /projects/prepare | path；校验并登记目录，激活有效 MCP，不创建会话 |
| POST /projects/pick | 本机页面的 Origin；返回 selected/path、cancelled 或 unavailable/message |
| GET /projects/directories?path= | 当前目录、上级和最多 1000 个子目录，不读取文件正文 |
| POST /sessions | 可选 requestId、path；省略 path 则分配独立默认目录，原空对象调用保持可用 |

同一创建 requestId 与不同目录冲突；同一请求返回同一会话。会话删除后保留请求墓碑，重试返回不存在。工作区仍用真实路径和目录身份检查，不接受根目录、应用数据或受保护工具链写入范围。

项目准备仅复用 path 与 identity 均相同的记录。用户重新选中身份已变化的目录（包括设备号变化）时返回新 Workspace ID，不改写原记录或迁移授权；GET /projects 按规范路径去重后显示最近登记。执行时的目录校验保持不变，旧会话不能借新登记绕过身份检查。接口字段、SQLite/SSE 版本不变。

## MCP

| 接口 | 输入 / 返回 |
| --- | --- |
| GET /mcp/overview?workspaceId= | 配置来源、作用域、启用状态、实时连接状态、工具列表；省略项目使用独立检测目录 |
| GET /mcp/config?scope=user\|project&workspaceId= | 脱敏 document、文件路径、revision 哈希、pending、containsSecrets、error 和此前有效文档 |
| PUT /mcp/config | scope、项目 ID、expectedRevision、document、可选 convertSecrets |
| POST /mcp/config/confirm | scope、项目 ID、expectedRevision、可选 convertSecrets；读取磁盘当前内容核对后确认 |
| POST /mcp/servers/:id/reconnect | workspaceId；关闭该项目旧实例并重新连接，不执行业务工具 |

旧 `/mcp/connections` 增删改入口同样经文件管理服务处理。旧连接测试/OAuth 回调接口保留；最终调用仍检查配置启用范围和工具版本。

配置必须使用 `mcpServers` 对象，服务支持 command/args 或 url、transport、enabled、toolExposure、auth、token、env、clientId、clientMetadataUrl、networkDomains、additionalPaths。旧 workspaceIds 为迁移兼容字段。未知字段明确拒绝；不是所有其他客户端配置的无损导入器。

`toolExposure` 是可选枚举 `deferred | direct`，缺省为 `deferred`。前者通过 search_tools 按需加载；后者向每次模型请求提供当前项目中该服务全部有效定义，仍执行权限检查。项目级条目整体覆盖，项目条目省略字段按 deferred 处理，不继承用户级 direct。工具提供方式参与配置版本与项目确认，变更可使旧模型响应里的工具版本失效。

本扩展保持 SQLite v4，连接 JSON 记录直接保存可选字段，无 DDL 迁移。旧记录读取按 deferred 解释；旧连接 API 同样支持该枚举，修改已有连接时省略字段保留此前选择，读取返回有效值。文件中省略字段始终表示默认按需。direct 不占用 search_tools 的分页或加载预算，但计入整体上下文字符预算；超限报 context_limit。配置修订沿既有取消/未知结果机制处理，不重放在途调用。

`token: "${secret:token}"` 和 `env: {"KEY":"${secret:env.KEY}"}` 是当前条目内的逻辑槽位，不是内部凭证 ID。原始秘密只在新提交或本机文件转换期间进入服务端内存。含明文时必须 convertSecrets；响应不会回显明文。修改服务身份后，旧引用不能直接用于新地址；需要重新填写凭证。

连接状态为 disabled、pending、disconnected、connecting、connected、authorization_required、error。工具目录按服务/版本/工作区隔离；页面不把 enabled 当成 connected，也不把过期目录当成当前可调用能力。

## 迁移与故障恢复

### 按需选择的会话持久化

仍使用 SQLite v4 的 execution_records，新增私有类型化集合 `sessionTools`，无需 DDL；不新增公开 API 或聊天事件。记录 `id=sessionId`、sessionId、workspaceId、workspaceIdentity、updatedAt，以及工具引用数组（name、version、connectionId、connectionRevision、definitionChars）。数组按最近选择排序，最多 16,000 个定义字符；引用不包含 Schema、认证数据或审批。

Run 检查点可选增加 `loadedToolBindings` 同形引用数组；旧 `loadedTools` 保留名称投影，不再作为单独的版本信任依据。缺少新字段按空选择处理，不从旧执行历史猜测版本。sessionTools 是会话的当前发现选择，检查点为当前 Run 副本；新 Run 在创建事务中继承，search_tools 在同一事务写入两者，先校验活动 Run，避免已结束/已删除运行的迟到结果复活选择。发现之后任务失败或被取消，不撤回此前已经提交且仍有效的目录选择。

每次快照校验允许的工作区、配置启用/信任/版本及当前定义版本；新 Run 额外核对保存的目录身份。临时断连仅保留引用和预算，只有重新发现相同版本才可见。配置或定义变更不能按名称自动接受新版本。没有发起新的 tools/call，也不会自动批准工具。会话删除外键级联清理缓存，重启不继承旧 connected 状态。direct 仍不进入按需选择预算。

### v4 配置文件迁移

0004_projects.sql 新建 session_creations；execution_records 增加 mcpFiles 类型化集合，connections 扩展来源、启用、阻断及原允许工作区。没有改变历史 invocation/attempt 的身份。

启动迁移把旧连接转换为用户级文件，保留连接 ID 和秘密引用；文件已有同名配置时以唯一后缀保留旧条目，不覆盖原配置。文件提交日志支持在文件已经替换、数据库尚未完成投影时恢复；不重放工具。

格式错误不返回含秘密的原文；并发编辑返回 revision_conflict；项目文件确认版本变化时必须重新查看。文件变更后已经派发的远端操作可能产生副作用，终止连接不是撤销执行。

备份须包含整个数据目录、项目配置和项目文件；Docker 数据卷和工作区卷分别备份。降级恢复 v4 升级前的完整备份，不能让旧代码打开 v4 数据库。
