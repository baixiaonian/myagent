# @myagent/web

本地聊天工作台、模型设置与响应式界面。已实现本地 Agent Loop 对应路径，其余完整 Agent 设计仍为骨架。

公共入口：`src/main.tsx`。

遵循 [根开发约定](../../AGENTS.md)、[当前状态](../../docs/STATUS.md) 和 [聊天协议](../../docs/protocols/chat-v1.md)。职责和依赖详见 [模块关系](../../docs/architecture/modules.md)。

Agent 接续入口：[自主循环设计](../../docs/architecture/agent-loop.md)；双协议与工具边界以当前协议和状态文档为准。

项目/MCP v4 已接通：目录选择与默认目录、双作用域文件配置和按项目连接状态，详见 [项目与 MCP](../../docs/architecture/projects-mcp.md) 和 [v4 协议](../../docs/protocols/projects-mcp-v4.md)。

上下文接续见 [上下文架构](../../docs/architecture/context-management.md) 和 [v6 协议](../../docs/protocols/context-v6.md)。本轮新增异步准备、来源化摘要、分页历史和容量展示；长期记忆 v1 已接通有界概览、两阶段提炼和按需检索，见 [记忆架构](../../docs/architecture/memory.md)。

工作台导航与展示：`SessionNavigation` / `session-groups` 按项目路径归类全部历史，独立目录聊天单独成组；`RunProcess` 按真实 Step 交错展示中间说明与可展开工具批次。界面参考本机 Qoder 的实际可见交互，详见 [本轮记录](../../docs/history/2026-09-26-project-conversations.md)。

轻量团队 v1 已接通：主 Agent 与成员共用唯一循环，独立历史和持久通信，复用现有权限/恢复；见 [团队架构](../../docs/architecture/teams.md) 和 [v11 协议](../../docs/protocols/teams-v11.md)。


工作台交互层见 `src/workspace.css`：整轮执行折叠、右侧团队、输入区审批、上下文占比及统一设置导航。审查来源、行为语义、验证与限制见 [2026-09-30 记录](../../docs/history/2026-09-30-workbench-design.md)。

## 文档工作区

点击回答中的 `.md` / `.html` 路径，或顶部「文档」，可并排浏览项目目录与多份文件。Markdown 在同一富文本画布读写、即时渲染，提供格式工具栏；HTML 默认交互预览，内嵌脚本、图表和筛选可以运行；文字编辑保留静态选段格式工具。预览无宿主同源/文件写回能力，外部网络及资源暂不加载，适用于自包含 HTML。选区浮层只有「添加到对话」，添加可展开移除的片段芯片；不再提供编辑按钮或替换弹窗。编辑停顿后自动保存，标签栏显示保存状态，关闭标签会先完成保存；冲突保留草稿并显示双版本。详细边界见 [文档协议](../../docs/protocols/documents-v1.md)。
