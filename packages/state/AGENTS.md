# 状态服务

上下文状态执行日志的正文与锚点引用同事务持久；压缩不改原文。executionNotes/previewLimits 是兼容可选字段，旧记录缺省为空，不伪造历史请求；用量缓存字段缺失表示未知。

继承 [根 AGENTS.md](../../AGENTS.md)，本文件补充当前目录规则。

明确 Session / Task / Run / Invocation 的唯一所有者。状态与关键事件提交保持一致，历史投影不能回放外部动作。涉及 schema 或事件变更时同步迁移、protocols 和恢复测试。数据库驱动放 adapters/storage。

每轮同步 [当前状态](../../docs/STATUS.md)、相关知识页和 [迭代记录](../../docs/history/README.md)。

已定义 ChatStore / CredentialStore / StoredStep 契约。StoredStep 的 identity 与 continuation 仅服务端可见，快照与 SSE 只提取 step；不要展开整个 StoredStep。Session revision 用于命令并发，cursor / seq 用于事件重放，二者不可混用。已终结 / 已删除 Run 不接受增量；重新生成的旧答案只有成功后才能 superseded。启动恢复中断不能重新执行模型。

ExecutionStore 是执行事实与检查点唯一仓储。v3 集合采用固定类型键；concerns 故意独立于会话外键，用于删除后保持未解决资源隔离。用户核对只能添加来源结论，不能覆盖原 unknown。

项目目录与配置文件使用独立 ports；mcpFiles 提交日志仅存脱敏文档、内部引用和版本，不存明文 Token。

sessionTools 是会话私有的按需工具选择引用；不存完整 Schema、凭证、连接状态或审批。loadedToolBindings 是 Run 内副本，loadedTools 仅为名称兼容投影。旧记录缺版本绑定时不得仅凭名称信任当前定义；新增集合复用 v4 JSON 存储与会话删除外键。

SQLite v5 增加 commandFiles 类型化集合，保存规则可信版本和 staged 提交日志；它不是第二份活动配置。ApprovalRequest/ToolInvocation 的 command 证据为可选新增字段，旧历史不回填。

上下文管理遵循 [根约束](../../AGENTS.md)：只在完整工具批次后准备上下文；摘要是有来源的派生资料，不改历史、不赋予权限。根规则在 Run 开始冻结，私有续接不进入摘要/公开历史。整理失败不自动重试，明确恢复不重放工具；长期记忆由 MemoryService 提供有界概览、检索与两阶段后台整理；启用/删除/人工保护遵循 memory-v7 协议。

Skill v1 遵循 [技能协议](../../docs/protocols/skills-v8.md)：完整主说明按 Run 独立注入且不被工具预览/摘要截断；激活和成功回执同事务；脚本仍经命令与沙箱。来源/启停下轮生效，当前只读包恢复不重放。数据库当前 v13；技能编辑器未实现；本地/公开 Git 插件生命周期已接通；Hook v1 已接通。

## Hook v1 约束

固定四事件在应用层接入，Kernel Loop 不增加 Hook 分支。配置确认绑定包与资源，默认项目只读，Worker 缓存身份包含完整权限；不继承模型工具授权。批次命中 Hook 时按模型顺序串行，未知副作用复用隔离核对，不重放。RunEnd 使用 cleaning 待提交结果；停止/删除/关闭不新启结束脚本。数据库 v12、Hook SSE v5；配置文件与包快照必须先落盘再引用，脚本日志不自动成为上下文。

## 插件 v1 约束

插件通过既有 Skill/MCP/Hook 提供者接入，不能新增执行循环或主进程模块加载。包内容先完整发布再事务登记；确认绑定哈希、作用域及配置。三类组件共用 Run 冻结版本，MCP 连接/目录/缓存也校验版本与项目。更新禁用卸载只影响新 Run；资源/凭证撤销仍立即约束派发。保留旧引用及未知结果后再回收，不修改手工配置，不删除源目录。SQLite v12；协议与维护见 docs/protocols/plugins-v10.md、docs/development/plugins.md（相对仓库根）。

## 轻量团队约束

只有主 Agent 创建/停止成员；成员内部会话独立，不出现在用户聊天列表。所有成员复用唯一 ChatService/runAgent；orchestration 不反向导入 application。消息、启动意图、完成回执与检查点必须事务提交，安全边界仅位于完整工具批次后。主任务提交前收拢成员；重启不自动请求模型或重放工具。

共享项目和权限上限，但一次审批不继承；成员不能修改长期记忆或独立贡献提炼。累计产出与耗时仅作统计，不设任务总时限或累计字符上限；全局模型 FIFO 包含摘要；等待不持有业务槽位。不得将入队表述为已读取，不能把成员成功视为任务质量验收。SQLite v12 / 团队 SSE v6，旧事件继续兼容。

## 观测接入

继承根目录观测约束：实际请求身份和用途必须穿过模型包装器；Kernel 只透传关联。原始调试正文的独立本机读取是私有续接不进普通 Web 投影的明确例外，仍不得进入 SSE、Agent 工具、日志或 OTLP。价格/账本/材料状态使用公共契约，不把缺损当成功。当前 SQLite v13，聊天事件不升级。

## 完全访问模式约束

用户选择的 executionMode 在 Run 创建时冻结，成员继承主 Run，恢复保持原值；缺失为 standard。full_access 跳过命令/资源策略及审批，以显式无沙箱 Worker 执行，不能由工具参数、规则文件或沙箱失败触发。上述沙箱/受保护路径保证仅适用于 standard；Hook 仍使用独立授权沙箱。完全访问不能声称隔离宿主凭证、应用数据或技能副本。

Worker 和 MCP 的连接/目录按模式隔离。Schema、路径身份、文件版本、意图/回执、取消、单次请求及采集容量边界和未知副作用核对不能跳过。权限选择不创建空会话，运行中不改模式。当前 SQLite v13；协议为仓库根 docs/protocols/execution-mode-v13.md。模式测试须包含真实项目外文件和网络、标准模式对照及成员继承。

ContextManifest.components 是兼容的诊断来源元数据，缺失时不回填。记录不含正文或厂商续接，原始事实和版本不改变。
