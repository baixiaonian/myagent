# MyAgent

- [执行权限：标准权限与完全访问](docs/protocols/execution-mode-v13.md)：输入区选择，按任务冻结，成员继承。

源码仓库：[baixiaonian/myagent](https://github.com/baixiaonian/myagent)（私有）。

一个可独立运行的单用户本地 Web Agent。通过 Responses 或 Chat Completions 连接自己的模型，聊天与执行记录保存在本机。统一自主循环支持直接回答、受控文件与命令、MCP、真实时间查询和可选计划；同时提供流式回答、多轮聊天、停止、重试、重新生成、Markdown 和会话管理。

## 本机启动

需要 Node.js 24+、pnpm 11.7.0。首次安装 better-sqlite3 若没有对应预编译包，需要系统 C++ 编译工具和 Python 3。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:5173>，在模型设置中选择协议，填写接口基础地址、模型 ID 和自己的 API 密钥。新配置默认 Responses，旧连接保留 Chat Completions。点击「测试连接」会发起一次简短模型请求，然后保存设置。无需在源码或环境变量中填写密钥。

生产构建和统一服务：

```sh
pnpm build
pnpm start
```

打开 <http://127.0.0.1:3000>。默认数据目录 `~/.myagent/`，可用 `MYAGENT_DATA_DIR` 指定绝对路径。后端端口可由 `PORT` 修改，Web 开发端口由 `MYAGENT_WEB_PORT` 修改；开发代理随之同步。例如 `PORT=3001 pnpm dev` 可避开已占用的 3000。开发命令同时管理包编译监听、后端与 Web。

## Docker

```sh
docker compose up -d --build
```

同样访问 <http://127.0.0.1:3000>。Compose 仅绑定本机地址，数据保存在 `myagent-data` 命名卷，容器内进程以普通用户运行。

## 数据与边界

- 会话、消息、运行、步骤、事件和脱敏配置：SQLite v13 / WAL；重启后保留，旧数据库自动迁移，升级前请备份。
- 密钥：独立凭证文件、目录 0700 / 文件 0600；采用文件权限保护，**未加密**。拥有本机账户权限的程序仍可读取。浏览器只保留本次输入中的新密钥，保存后清空，不使用浏览器持久存储保存凭证。
- 聊天内容发送给你配置的模型服务。页面刷新或关闭不会停止服务端生成；停止按钮会取消请求，保留部分回答。
- 只适用于可信本机单用户环境；支持工作区权限、审批和原生执行，不提供公网访问、登录、多租户或附件。兼容服务差异需要实际验证。

## 验证和维护

```sh
pnpm verify
pnpm exec playwright install chromium
pnpm test:e2e
```

[使用与维护](docs/development/setup.md) · [项目当前状态](docs/STATUS.md) · [架构与模块](docs/architecture/overview.md) · [API 协议](docs/protocols/chat-v1.md) · [测试证据](docs/development/testing.md) · [迭代历史](docs/history/README.md)

继续开发前请阅读 [AGENTS.md](AGENTS.md)、[文档知识地图](docs/README.md) 和 [自主循环设计](docs/architecture/agent-loop.md)。上下文、长期记忆、Skill、Hook 和插件管理已接通；轻量多 Agent 团队已接通，Workflow、知识库及 CLI 继续作为骨架。原始 [HTML 设计报告](agent-architecture.html) 是完整 Agent 的设计基线，不等于当前实现范围。

新对话在输入区选择项目目录；未选择时，首次发送会分配独立默认目录。用自然语言提出文件/命令任务，项目授权与 MCP 在各自入口管理。详见 [工具使用与平台依赖](docs/development/tools.md)、[工具执行架构](docs/architecture/tool-execution.md)。`pnpm test:execution:native` 验证原生隔离；已授权真实模型时可运行 `pnpm test:execution:live`。标准模式下，默认 Docker 不提高权限，嵌套沙箱不可用时明确拒绝执行；完全访问模式须由用户显式选择，见 [执行模式](docs/protocols/execution-mode-v13.md)。

项目选择与 MCP 设置使用说明：[新对话工作目录、双作用域配置和连接状态](docs/development/projects-mcp.md)。默认工作目录可通过 `MYAGENT_WORKSPACE_ROOT` 指定；Docker 工作区使用独立持久卷。

### 命令权限

设置中的“命令权限”管理用户级/项目级规则，支持表单、JSON 和不执行命令的规则测试。标准模式下，明确的低风险读取自动执行，其余默认询问；命令批准仅本次，资源权限和沙箱仍独立生效。升级至 SQLite v13 前备份数据与项目目录。详见 [使用与维护](docs/development/commands.md)。

上下文管理支持根项目规则、预算估算、单轮内摘要与历史原文查阅；详细配置和费用说明见 [上下文维护](docs/development/context.md)。

侧栏“长期记忆”可启用空闲两阶段提炼、跨会话检索、人工编辑/遗忘和来源查阅。默认关闭，后台调用单独计费；首次开启不回溯旧历史，可手动选择整理。详见 [记忆使用说明](docs/development/memory.md)。

## 本地 Skill

已支持用户级/项目级 Skill，目录渐进加载、Run 内完整说明和只读脚本资源。入口为“技能”设置与输入区技能按钮；使用、目录和权限见 [Skill 说明](docs/development/skills.md)。

Hook 使用与恢复见 [Hook v1](docs/development/hooks.md)；四事件脚本在设置页精确授权，默认项目只读，不改变模型工具权限。

## 插件

侧栏“插件”支持本地目录或公开 HTTPS Git 安装、预览准确版本与权限、用户/项目作用域、启停、更新/回退和卸载。安装示例 `plugins/report-assistant/` 可体验 Skill、MCP 与 Hook 协同。旧任务固定旧版本，新任务使用新配置；卸载不会删除源目录和项目产物。见 [使用维护](docs/development/plugins.md) 与 [兼容协议](docs/protocols/plugins-v10.md)。

## 轻量团队

模型可以创建成员、自定义角色和背景，成员独立执行并直接通信。主 Agent 收集结果后统一交付，也可亲自执行。团队面板查看过程、审批、停止和复用成员。见 [使用维护](docs/development/teams.md)。

## 执行记录与用量

侧栏打开“执行记录与用量”，查看按会话、模型、日期和用途的用量。显式开启调试后，聊天回答下方可查看 Trace 时间轴、每次实际模型请求的原始输入输出并下载。原始材料只留本机，不随 OTLP 外发；价格不明确时显示未知。详见 [使用说明](docs/development/observability.md)。
