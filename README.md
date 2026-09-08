# MyAgent

源码仓库：[baixiaonian/myagent](https://github.com/baixiaonian/myagent)（私有）。

一个可独立运行的单用户本地 Web 聊天机器人。连接自己的 OpenAI 兼容模型接口，聊天记录和配置保存在本机。支持流式回答、多轮聊天、停止、重试、重新生成、Markdown 和会话管理。

## 本机启动

需要 Node.js 24+、pnpm 11.7.0。首次安装 better-sqlite3 若没有对应预编译包，需要系统 C++ 编译工具和 Python 3。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:5173>，在模型设置中填写接口基础地址、模型 ID 和自己的 API 密钥。点击「测试连接」会发起一次简短模型请求，然后保存设置。无需在源码或环境变量中填写密钥。

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

- 会话、消息、运行、事件和脱敏配置：SQLite WAL；重启后保留。
- 密钥：独立凭证文件、目录 0700 / 文件 0600；采用文件权限保护，**未加密**。拥有本机账户权限的程序仍可读取。浏览器只保留本次输入中的新密钥，保存后清空，不使用浏览器持久存储保存凭证。
- 聊天内容发送给你配置的模型服务。页面刷新或关闭不会停止服务端生成；停止按钮会取消请求，保留部分回答。
- 只适用于可信本机单用户环境，不提供公网访问、登录、多租户、工具、联网搜索或附件。兼容服务差异需要实际验证。

## 验证和维护

```sh
pnpm verify
pnpm exec playwright install chromium
pnpm test:e2e
```

[使用与维护](docs/development/setup.md) · [项目当前状态](docs/STATUS.md) · [架构与模块](docs/architecture/overview.md) · [API 协议](docs/protocols/chat-v1.md) · [测试证据](docs/development/testing.md) · [迭代历史](docs/history/README.md)

继续开发前请阅读 [AGENTS.md](AGENTS.md) 和 [文档知识地图](docs/README.md)。未参与本轮的 Agent 扩展、工具、Worker 等仍为骨架。原始 [HTML 设计报告](agent-architecture.html) 是完整 Agent 的设计基线，不等于当前实现范围。
