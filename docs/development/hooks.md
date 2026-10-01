# Hook 使用与维护

1. 准备独立脚本包，例如用户 `~/MyAgent/Hooks/check/` 或项目 `.myagent/hooks/check/`，入口 `main.mjs`。
2. 打开 Web「Hook」，选作用域，编辑 JSON。格式见 [协议](../protocols/hooks-v9.md)。点击「预览配置与权限」，核对事件、脚本、版本、写路径与网络域名，再「确认授权并保存」。设置页不运行脚本。
3. 新建/继续任务触发生效。外部编辑配置或包后刷新页面、重新预览确认；在途任务仍使用旧快照，立即停用须停止任务。
4. 执行过程中的 Hook 条目显示完成、拒绝、失败、待核对和日志入口。模型补充信息不改变原工具结果；日志通过受会话约束的结果库读取。

最小 Node 脚本：

```js
/** 项目启动资料：只处理标准输入，不读取凭证。 */
import fs from "node:fs";
const event = JSON.parse(fs.readFileSync(0, "utf8"));
console.error(`触发事件：${event.event}`); // 日志，不自动交给模型
console.log(JSON.stringify({ decision: "continue", additionalContext: "本项目使用中文报告。" }));
```

RunEnd 不允许 additionalContext。PreToolUse 拒绝使用 `decision: "deny"` 和 `reason`；不要用退出码 2 表示控制结果。默认只读，格式化脚本需在 permissions.writePaths 中声明项目内路径。安装依赖由用户在包之外自行准备，本轮不冻结依赖或自动安装。

默认用户脚本根可通过 `MYAGENT_HOOK_ROOT` 覆盖；Docker 使用独立 `/hooks` 卷。备份完整数据目录、项目 `.myagent` 和脚本来源；`hook-packages` 是恢复旧 Run 所需持久包，临时只读运行副本可重建。v9 回退恢复升级前完整备份，不能修改 user_version 绕过检查。

故障：JSON 错误先修复原文；版本冲突刷新后核对；沙箱缺失安装原生依赖，不裸进程重试；unknown 先查结果和产物，再在现有执行面板核对，核对不会回滚或重做操作。配置和脚本路径属于后端所在机器。

验证命令：`pnpm test:hooks`、`pnpm verify`、`pnpm test:e2e`、`pnpm test:execution:native`、`pnpm test:docker`。`pnpm test:hooks:live` 仅在有真实模型调用授权时手动运行，在临时实例复用既有服务端凭证，结果位于 `.cache/acceptance/hooks-live.json`，不修改原设置。

本轮平台证据：macOS 原生脚本执行通过；当前 Docker 环境缺少可用的嵌套隔离能力，脚本返回 sandbox_unavailable，保持拒绝执行。Docker 通过的是升级、配置/快照/记录持久化与拒绝降级的验证，不能据此声称 Linux 原生 Hook 已成功执行。
