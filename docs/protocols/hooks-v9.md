# Hook v1 / SQLite v9 / SSE v5

Hook 是固定事件上的本地脚本扩展；没有新的模型请求、Step 或 Agent 循环。Skill 提供指南，Hook 响应生命周期；两者都不扩大模型工具授权。

## 事件与故障

| 事件 | 位置 | 可以返回 | 故障策略 |
|---|---|---|---|
| RunStart | Run 与快照提交后、首次模型请求前，每 Run 一次 | additionalContext | 停止本轮 |
| PreToolUse | 完整工具名称/参数校验后、业务派发前 | additionalContext 或 deny + reason | 拒绝本次调用，模型自行决定下一步 |
| PostToolUse | 已真实派发且已知成功/失败回执落库后 | additionalContext | 警告，保留业务回执 |
| RunEnd | 待提交业务结果持久化到 cleaning 后 | 空输出或 continue | 警告，不改变回答、不继续模型 |

拒绝、未知结果、取消没有 PostToolUse。exec_command 返回进程句柄也是一次调用返回，不能当成进程已退出。用户停止、删除、服务关闭不启动 RunEnd；恢复不会为中断任务补造结束事件。

## 配置与授权

用户 `<dataDir>/hooks.json`；项目 `<project>/.myagent/hooks.json`。`schemaVersion:1`、`hooks` 有序数组，每个 ID 在作用域内唯一，双作用域按用户→项目叠加。同名不覆盖。

```json
{
  "schemaVersion": 1,
  "hooks": [{
    "id": "project-check",
    "event": "PreToolUse",
    "enabled": true,
    "packagePath": ".myagent/hooks/project-check",
    "entry": "main.mjs",
    "interpreter": "node",
    "args": [],
    "tools": ["write_file", "edit_file"],
    "timeoutMs": 30000,
    "permissions": { "writePaths": [], "networkDomains": [] }
  }]
}
```

项目相对路径以项目根为基准；用户相对路径以 `~/MyAgent/Hooks/` 为基准，`MYAGENT_HOOK_ROOT` 可覆盖。支持绝对包路径。解释器仅 `node`（服务端实际可执行文件）、`python3`（固定系统/Homebrew 候选）、`sh`（/bin/sh）；不从工作区 PATH 解析同名程序。固定参数置于入口文件之后，事件从 stdin 传入。

启用项的整个包内容哈希、解释器身份、配置共同组成准确版本。设置保存先预览，再提交 expectedRevision + expectedVersion；仅预览不写文件、不授权。确认不生成 command-rules 放行，也不是对任何同名模型工具的许可。外部首次新增未确认配置不执行；已经确认的配置、包变更或删除会阻止该作用域的新 Run。非法 JSON 保留原文本和上一确认状态。

先完整发布包快照，保存 staged 文件提交日志，然后 CAS + fsync + rename 写配置。读取/下个 Run 对账日志；只有文件和包仍匹配才恢复确认。原子替换不是对任意外部编辑器的全局事务。

## 沙箱与并发

Hook 默认只读当前项目与只读包。写权限仅项目内相对路径，网络仅具体公网域名；无项目外文件、数据目录、宿主凭证、交互终端。Worker 配置按 origin、Run、目录身份、完整资源和只读包隔离缓存。沙箱不可用则拒绝，不降级裸进程。

Skill / Hook 共用 `LocalPackageFiles` 的校验、内容哈希、发布和只读运行副本。运行源与持久包分离；恢复从旧包重建，不能读取新脚本替换旧快照。包上限单文件 20 MiB、单包 100 MiB、10000 项；不跟随包内链接、不接收特殊文件。

工具与 Hook 共用 `ExecutionCoordinator` 的资源锁/全局 8 槽。批次只要有一个匹配的工具 Hook，就按模型顺序执行前置→工具→后置；无匹配继续原每 Run 4 并发策略。动作分别加锁，前后 Hook 不持有业务工具的锁，不是文件事务。进程尚在运行时原工具锁继续有效，后置写入可能等待或超时。

每 Hook 默认 30 秒、上限 120 秒，启动与工具 Hook 计入 Run 活动时间。全部 RunEnd 共用额外 5 秒收尾预算。超时/取消向实际进程组传播；不能确认结果则保留 unknown 与资源隔离，先人工核对，不按警告策略继续冲突动作。

## 输入、输出与上下文

stdin 为 `HookInput`：版本、事件 ID、Run/会话、工作区、当前问题，以及该事件的工具参数/安全结果预览或结束结果。大型参数有界投影，附调用来源；不传模型设置、密钥、私有续接和完整历史。

stdout 成功时为空或一个 JSON；stderr 为日志。未知控制字段、非零退出、非法 JSON、输出超过 64 KiB 都失败。

```json
{ "decision": "continue", "additionalContext": "报告已格式化，请读取产物核对。" }
```

只有 PreToolUse 接受 `{"decision":"deny","reason":"原因"}`。RunEnd 不接受 additionalContext。原输出和进程日志进入结果库；模型补充信息最多 8000 字符，采用首尾预览和结果引用。原回执不会被覆盖。

RunStart 资料独立复用且计入必要上下文；前后资料按顺序放在完整工具批次之后，保持两种模型协议 assistant/tool 完整配对，允许摘要。历史查询可按 Hook 来源 ID 搜索，完整结果用 read_tool_result 补读。日志不自动注入模型，补充资料不成为授权。

## 状态和接口

`hook_records` 保存 files（授权/日志）、runs（冻结配置与包/待提交结果）、events（独立执行身份和应用状态）。真实 attempts 标注 `origin:hook`，没有伪造的模型 callId 或 Step；工具记录标注 origin:tool。事件/回执/应用标记与 SSE 同事务。事件 ID 绑定 Run、触发位置与 Hook 版本；已完成事件不会重放。

重启仅核对 Worker 持久回执；已开始但没有可靠回执的 Hook 进入 unknown。手动恢复继续未执行位置；已核对 unknown 保留原事实，不能重新假造成功或自动重做。取消后的迟到结果不能应用上下文。会话删除级联删除 Hook 引用；未解决隔离事实保留，脚本源目录不删除。

| API | 用途 |
|---|---|
| GET /api/v1/hooks/config?scope=user 或 project&workspaceId=… | 读取文本、路径、准确版本、确认状态 |
| PUT /api/v1/hooks/config | 缺 expectedVersion 时只预览；确认后 CAS 保存 |
| POST /api/v1/hooks/confirm | 确认外部编辑的 revision/version |
| GET /api/v1/sessions/:id/hooks | 安全执行记录，不返回私有 stdin/授权内部状态 |

新增 `hook.updated` SSE v5；SDK 延续 v1–v4 读取和 seq 去重。SQLite v8→v9 只建表、索引，旧历史保持可读，不创建默认 Hook，不启动脚本；未来数据库版本继续拒绝旧程序打开。
