# 2026-10-01：公开组合插件兼容检查与 Hook 缺口

## 目的与发现

用户指出此前选择的公开可视化插件只有 Skill，不能充分验收插件的 MCP 和 Hook 接入。上次验收覆盖不足；限定结论不能代替补查真实组合插件。

核对公开仓库 [sqlew-io/sqlew-plugin](https://github.com/sqlew-io/sqlew-plugin)：`.codex-plugin/plugin.json` 同时声明 Skill、MCP 和 Hook。通过运行中 MyAgent 的管理 API 发起 Git 安装预览，作用域为此前保留的公开插件验收项目，未修改第三方包。

- 固定提交：`32fe64592f410b00a0fcf9fbbf57338d9fb0d0f0`，声明版本 5.3.2。
- 包版本：`36ce677377639e049cc0fa21c4c10f0fd5f5a8de9d808d10a9e722b51516e552`。
- 预览任务：`preview:433f8c18-dcb4-46e8-8186-0fba4af44c60`，状态 ready，包含阻断项。ready 仅代表候选准备完毕，不代表可以启用。
- 识别到 3 个 Skill、1 个 MCP；MCP 启动命令是 `sqlew`。当前 Shell PATH 未发现该命令，未声称运行依赖已就绪。
- Hook 被标记 `external:hooks`：当前解析器只接通 `extensions.com.myagent` 的原生 Hook 声明，不直接执行第三方 Hook 协议。
- 未排除 Hook，未提交安装确认，没有执行插件代码、MCP 握手、业务调用、Hook 或付费模型请求。原可视化插件保持安装状态。

## 验收结论与接续

组合插件完整使用验收尚不通过。Skill/MCP 声明解析、MCP 实际连接调用、Hook 触发及权限检查是不同证据，不能互相替代。后续若支持此类原样安装，需要明确外部 Hook 事件、工具匹配、stdin/stdout、资源授权与缺失事件的兼容方式；不能简单改名或排除全部 Hook 后宣称通过。

完整预览及请求保存在 `.cache/acceptance/public-plugin-composite-preview.json`，不纳入 Git。本轮只检查公开包及记录能力缺口，没有产品代码变更；无需重跑模型或工程全量验证。检查根及 docs 约定，无新增开发规则，同步 STATUS、维护说明和历史索引。
