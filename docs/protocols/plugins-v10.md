# 插件 v1 / SQLite v10

插件是 Skill、MCP 和 Hook 的分发与管理单元，不是新的执行框架。Kernel 无插件分支。公共类型见 `packages/contracts/src/plugins.ts`。

## 包格式

优先读取根 `plugin.json`，其次 `.codex-plugin/plugin.json`。两者转换为 `PluginManifest`，内容哈希才是实际版本；声明版本仅展示。标准根格式自动发现 `skills/*/SKILL.md` 和 `mcp.json`，兼容格式接受 `skills`、`mcpServers` 的受限声明。原格式记录为 agent 或 codex。

原生 Hook 在清单中声明 `extensions.com.myagent: {"apiVersion":1,"hooks":"hooks/myagent.json"}`，文件使用现有 Hook 协议。未知组件、外部 Hook、连接器、依赖、变量等形成逐项阻断报告；用户排除的组件 ID 进入确认指纹。不会自动映射其他系统的 Hook 事件或授权。

MCP 配置和已加载 Skill 正文中的根变量 `${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` 指向本轮只读运行副本；不展开宿主环境。认证材料通过确认接口的独立 credentials 字段录入凭证服务，公开配置不返回内部引用。包内已有 token/env 明文的组件必须先适配或排除，避免展示或沿用秘密。支持的 MCP 配置字段以解析器和现有 MCP 校验器为准。

包中禁止链接、特殊文件和越界路径；单文件 20 MiB、包 100 MiB、10000 文件/目录。Skill 主说明沿用 64 KiB。Git 抓取共用 120 秒取消信号、暂存目录 200 MiB，上限按周期检测；不承诺磁盘瞬时占用绝不越过阈值。

## 管理接口

| 路由 | 输入和行为 |
| --- | --- |
| GET `/api/v1/plugins?scope=user\|project&workspaceId=…` | 安装、版本、兼容性、组件、连接状态与旧 Run 占用 |
| POST `/api/v1/plugins/preview` | requestId、action（install/update/configure/rollback）、scope、workspaceId、expectedRevision、source、enabled、selection；创建持久候选任务 |
| GET `/api/v1/plugins/jobs` | 同作用域最近 100 个管理任务，可重新打开待确认预览 |
| GET `/api/v1/plugins/jobs/:id` | 准备、待确认、提交、取消、失败、中断状态 |
| POST `/api/v1/plugins/jobs/:id/confirm` | requestId、confirmation 精确哈希、可选 credentials；提交全部组件 |
| POST `/api/v1/plugins/jobs/:id/cancel` | requestId；取消未提交任务，重复取消不改变结果 |
| POST `/api/v1/plugins/:id/change` | requestId、expectedRevision、目标范围、disable/uninstall/inherit |

source 为 `{kind:"local",path}` 或 `{kind:"git",url,ref?,subdirectory?}`。selection 为 `{excluded:[组件ID],mcp:{组件ID:配置覆盖}}`。MCP 的设置覆盖仍完整经过资源/认证校验；toolExposure 缺省 deferred。

确认哈希绑定包、目标范围、组件选择、启用状态和预期修订号。更新预览固定提交，确认不重新解析分支。管理幂等记录和操作指纹防止重复发布；版本冲突返回 409。相同内容和配置返回无变化，不推进修订号。

## 持久化与生效

`plugin_records` 保存 versions、bindings、jobs、runs、operations、credentials 引用管理记录。不可变包位于数据目录 `plugin-packages/`；只读运行副本可重建。记录不保存凭证明文。文件先发布，确认阶段保存 staged 提交意图，事务最后切换 binding 与全部组件来源。启动将未完成任务标为 interrupted，不联网重试、不调用模型。

Run 创建事务冻结 bindings；Skill/Hook/MCP 使用同一集合。连接 ID 包含安装身份、包版本/配置指纹和工作区；MCP 目录检索、缓存复用和调用均复核本轮引用。原有手工配置文件保持原样。Hook 同作用域先独立 Hook、后按插件身份排序。

禁用不删包；卸载撤销该范围登记。项目卸载留禁用覆盖，只有明确“恢复继承”才回到用户级。活动/暂停/可恢复 Run、进程和未知结果阻止有关版本回收；已采集历史仍按原系统保留。删除后仍有未核对执行事实时，保守暂停插件物理回收，避免引用已被会话级联清理造成误删。授权撤销、凭证撤销、目录身份检查不会被版本冻结绕过。

v9→v10 只增结构，无默认安装或自动组件迁移；旧程序拒绝新数据库。聊天快照增加 `plugins` 引用，组件 DTO 增加可选 `plugin` 来源，仍使用既有 Skill/Hook SSE 事件。
