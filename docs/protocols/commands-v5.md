# 命令权限协议 v5

权限模式补充：本文中的命令规则、审批与沙箱保证适用于默认**标准权限**。用户可在输入框旁选择**完全访问**，新 Run 与成员免命令/资源审批并采用无沙箱工具进程；停止、超时、版本和未知结果校验仍保留。Hook 继续使用独立授权。详见 [执行模式 v13](../protocols/execution-mode-v13.md)。


HTTP 保持 `/api/v1`，聊天事件保持 v3 并兼容旧版本。SQLite 升至 v5，迁移见 [0005_commands.sql](../../migrations/0005_commands.sql)。本能力只治理 `exec_command` 的启动命令；交互程序获准后，`write_stdin` 不逐次询问，不拦截解释器内部或子进程的每次动作。

## 规则与判断

文件是规则来源：用户级为数据目录 `command-rules.json`，项目级为 `<项目>/.myagent/command-rules.json`。文档格式如下，数组顺序不代表优先级：

```json
{
  "schemaVersion": 1,
  "rules": [
    { "id": "git-status", "pattern": ["git", "status"], "decision": "allow", "description": "允许常用状态检查" },
    { "id": "confirm-npm", "pattern": ["npm"], "decision": "prompt" },
    { "id": "deny-rm", "pattern": ["rm"], "decision": "deny" }
  ]
}
```

每个静态 argv 单独按完整参数前缀匹配；`git status` 不匹配 `git status-other`。参数不做字符串模糊匹配；`rm` 与 `/bin/rm` 是不同的参数，需要各自配置。ID 在同一文件唯一，项目同名 ID 不覆盖用户规则。所有命中采用 deny > prompt > allow；没有命中才使用默认分类。

默认低风险清单为已核验实际来源和限定参数的 pwd、ls、cat、head、tail、wc、grep、rg；未知选项询问。Git、脚本、解释器和安装删除命令默认询问。可执行文件按 Worker 共用的固定 PATH 定位，身份参与批准绑定；工作区同名程序不获得系统工具豁免。

WASM Shell AST 检查管道和复合命令，整个调用采用最严格结论。重定向、动态展开、替换、复杂控制流及包装调用保守询问完整命令，宽泛 allow 不能直接放行这些语法；可识别的嵌套命令仍检查显式 deny。语法错误或解析器不可用时不派发。分析不会执行或改写原命令。

这些是启动权限，不能证明脚本内部无危险动作；放行程序表示信任其后续行为。命令 allow 不授予目录或网络权限，不替代 OS 沙箱。

## API

| 方法与路径 | 输入 / 输出 |
| --- | --- |
| GET /command-policy/config?scope=user\|project&workspaceId= | 文件路径、原文、原始 revision、有效文档、此前可信文档、pending/error |
| PUT /command-policy/config | scope、可选 workspaceId、expectedRevision、text；严格解析后原子保存并确认 |
| POST /command-policy/config/confirm | scope、可选 workspaceId、expectedRevision；确认所展示的准确文件版本 |
| POST /command-policy/evaluate | workspaceId、command、可选 cwd；返回命令分析、规则来源、决策和原因，不创建进程 |

项目操作必须提供有效项目身份。用户级配置不接收 workspaceId。规则最多 200 项，每项非空 pattern 最多 100 个参数，未知字段拒绝。HTTP JSON 原文最多 60,000 字符且仍受请求体上限约束；本机文件读取最多 256 KiB。清空通过 `rules:[]` 保存；非法 JSON 不以空规则覆盖有效配置。

设置测试使用已保存规则，不读取页面草稿。它检查路径有效性与命令策略，不表示真实执行所需的资源授权或沙箱已经通过。

## 生效与审批

- 用户级文件位于 Agent 不可访问的数据根，本机外部编辑可直接生效；拒绝将它通过符号链接指向数据根外部，避免模型可写项目文件获得用户级自动信任。项目级外部有效变更、清空或删除进入待确认；比较规范化后的语义版本，排版不重新询问。确认仍要求所展示的原始文件 revision 一致。
- 非法配置、待确认变更或无法读取的配置阻止当前项目的新命令，不静默使用更宽松默认值。用户在设置页保存即确认本次文档。文件修改本身不提供模型可调用的确认工具。
- `ApprovalRequest.command` 与 `ToolInvocation.command` 为新增可选字段，保存完整命令、cwd、分析、命中规则、policyRevision 和 binding；字段缺失表示旧资源记录。
- 有 command 字段的批准仅接受 `scope:once`，后端拒绝 session/workspace。命令与缺少的资源合并展示和批准；纯资源批准保留原范围。
- binding 绑定 invocation/session/run、规范参数指纹、工具版本、工作区身份、配置版本及可执行文件身份。批准状态与单次授权必须有效；重启撤销旧单次授权。旧资源批准不能满足命令 prompt。
- 审批后、等待资源锁和全局槽之后、Worker 就绪但动作尚未发送时复核。排队时版本变更可以重新生成审批；Worker 准备期间变更返回未派发错误，不自动重新执行。
- 新配置控制后续派发，不终止已经开始的程序，也不撤销已经发生的副作用。取消、未知结果和人工核对保持 [执行 v3](execution-v3.md) 的语义。

## 存储、恢复与边界

v5 继续使用 `execution_records`，新增类型化 `commandFiles` 集合，保存可信语义哈希、此前文档和 staged 提交日志。先持久化日志，再 CAS/fsync/rename 文件，最后投影数据库。若 rename 后失败，保留日志；重启或再次读取时仅在磁盘匹配待提交内容时恢复确认。外部已改成第三个版本时不覆盖、不继承先前确认。

迁移只增加索引与版本门禁，不回填历史判断、不重放命令。旧程序会因 user_version=5 拒绝打开数据。备份必须包含数据目录和项目文件；降级恢复升级前备份。

文件校验到 rename、规则复核到实际进程执行之间仍存在外部进程竞态；不宣称跨任意外部编辑器的强事务。程序及脚本的内部行为受 OS 资源边界约束，本轮不做子进程命令拦截或第二次模型风险评估。
