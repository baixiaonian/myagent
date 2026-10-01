# 项目选择与 MCP 设置改造

- 日期：2026-09-15
- 目的：消除创建工作区/绑定会话的前置步骤，提供文件与表单共用的 MCP 管理体验。

## 完成项

新对话原生选目录、最近项目、页面目录浏览回退；首次发送原子绑定，默认每会话独立工作目录，创建幂等和删除墓碑。删除聊天保留产物；旧未绑定会话按用户下一次提交补充分配。

MCP 独立设置页，用户级/项目级 JSON 文件、同名覆盖、启停、实时状态、完整工具目录、表单和 JSON 编辑器、OAuth 入口。项目外部配置变更确认准确版本；凭证单独保存，文件使用逻辑槽位。配置提交日志支持 rename 后失败恢复；纯排版改动不重启连接，修改一个服务不会中断无关服务。

运行实例/状态/工具目录按项目隔离，重启重新发现；配置改变取消旧实例并保留 unknown 语义。业务 tools/call 不自动重放。系统目录窗口由 Finder 带到前台；Linux 无桌面提供页面回退。

SQLite v4 与旧 MCP 导入，Docker 默认工作区独立卷。既有模型 Loop、审批、停止、SSE 和恢复路径保持；网络错误后的后台快照补读不再占用提交门禁。

## 验证证据

- 工程和专项：`.cache/project-mcp-verify-final.log`、`.cache/project-mcp-tests-final.log`。
- 浏览器：`.cache/project-mcp-e2e-final.log`，覆盖原聊天/执行流程和新增默认目录、MCP JSON/开关。
- macOS 原生文件夹窗口：`.cache/acceptance/native-picker.json`，真实选择独立临时目录、取消均通过；首次权限未授予的尝试保留为过程事实，权限恢复后重新验证。
- 真实 DeepSeek deepseek-v4-flash / Chat Completions：`.cache/acceptance/projects-live.json`。默认目录和指定目录各 4 次模型调用，实际文件与命令验证通过，原设置未变。
- Docker：`.cache/project-mcp-docker-final.log`、`.cache/acceptance/docker.json`。最终 11 项通过，ok/cleanup 均为 true；首次新增的第二会话未清理导致测试末尾失败，已修正脚本清理并重新验收。

最终验收：108 项工程测试、12 条浏览器流程、9 项原生专项通过；新项目/MCP 专项 11 项。当前本机服务已更新至 v4，原会话和模型配置保留，备份位置见 `.cache/project-mcp-backup.json`。本轮未提交推送。

## 边界与接续

MCP 证据使用真实本地 HTTP/stdio 协议替身，不是截图中外部服务账号验收；未连接截图服务。Linux 桌面 Zenity 窗口未在本机运行，回退与原生窗口证据分开。没有新增依赖或公开部署，也没有提交推送。

已检查并同步根、apps、server/web、application/adapters/state、scripts/tests 的 AGENTS。模块依赖边没有变化，config/modules.json 无需空改。继续从 [架构](../architecture/projects-mcp.md)、[协议](../protocols/projects-mcp-v4.md)、[使用说明](../development/projects-mcp.md) 阅读。
