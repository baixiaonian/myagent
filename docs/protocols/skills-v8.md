# Skill v1 / SQLite v8

Skill 的发现与正文是上下文能力；执行协议、命令审批与唯一循环保持原边界。数据库 v8 与聊天 SSE v4 独立编号。

## 管理 API

| 接口 | 内容 |
| --- | --- |
| GET /api/v1/skills?workspaceId= | 对应项目的用户级/项目级目录、来源、错误、当前版本 |
| POST /api/v1/skills/refresh | body 可带 workspaceId，重新扫描 |
| GET /api/v1/skills/:id?workspaceId= | 当前主说明、兼容提示与资源清单，只读 |
| PATCH /api/v1/skills/:id | enabled、可选 workspaceId；从下个 Run 生效 |
| GET /api/v1/skill-sources?workspaceId= | 来源目录 |
| POST /api/v1/skill-sources | path、scope=user/project、项目级需 workspaceId |
| PATCH /api/v1/skill-sources/:id | expectedRevision、enabled 或 scope/workspaceId |
| DELETE /api/v1/skill-sources/:id | 注销额外来源，不删除源文件 |

发送/重新生成可带 skillIds 字符串数组，按稳定 ID 去重排序后进入幂等指纹。$name 仅解析唯一可用名称，代码块/行内代码/转义忽略；重名需结构化选择消歧。重新生成未传 skillIds 时继承原问题显式选择；普通追问不继承。

## 工具

- search_skills：query 普通关键词、cursor；仅查询本轮冻结可用目录，最多 20 项和 8000 字符，完整目录不会因提示预算而丢失。
- load_skill：id；主说明版本或目录身份变化则 skill_changed。暂存包由回执事务提交激活，工具本身只回传版本/位置和成功状态。
- read_skill_resource：id、可选 path/cursor。空 path 分页列资源，必须已在本轮激活；二进制仅提供位置/大小，文本逐页读取，禁止 ../ 或任意路径。

activeSkill：ID、名称、来源、主说明版本、包版本、运行根目录、explicit。ContextView.skills 增加 active/catalogTokens/instructionTokens/omitted；stats.breakdown.skills 提供技能估算。旧字段和事件读取兼容，不公开厂商续接。

## 持久化与安全

skill_records 以 kind/id 管理 sources、enabled、runs、packages；Run 引用含 session 外键，包使用内容哈希复用。只有生成期间需要的历史事实快照进入数据库，不覆盖源文件。v7→v8 仅建结构，不自动读取额外目录或调用模型；旧程序拒绝打开 v8。

读取适配器捕获的包默认 100 MiB，单文件 20 MiB，SKILL.md 64 KiB。源码授权不等于执行授权；脚本通过现有执行工具，自动只读范围只含当前 Run 的包，写入、网络、命令规则照旧。

[架构](../architecture/skills.md) · [运维](../development/skills.md)
