# 2026-09-12：自主 Agent Loop 与双协议

## 目的与范围

把本地 Web Chat 升级为统一 Agent 循环，模型自主选择工具和维护计划。接通 Responses / Chat Completions、最小上下文、计划与时间工具、持久步骤以及 Web 执行过程。不实现固定规划器、反思器、完整工具治理或内容系统。

## 模块与协议变化

8 个现有模块扩展，无新增 workspace 或内部依赖边。adapters 新增实际使用的 Ajv 8.20.0（MIT，无安装脚本）。SQLite 升级至 v2，新增 run_steps；事件 v2 增加步骤更新/增量，SDK 保持 v1 读取兼容。Settings 增加 apiProtocol，旧配置不会被切换。

服务端记录完整续接材料，公开只投影 Step。调用先保存后执行，结果保存后继续；重新生成的过程与计划按 Run 隔离。资源上限可配置，不限制固定轮数。

## 验证证据

- `pnpm verify` 通过：74 项 Vitest（原 32 项 + 新增 42 项）、格式、依赖边界、文档、类型、生产构建与浏览器产物检查。日志 `.cache/acceptance/agent-verify.log`。
- `pnpm test:e2e` 7 组全部通过，覆盖原聊天流程与两种协议的计划/工具/刷新/重新生成。日志 `.cache/acceptance/agent-e2e.log`。桌面/390px 窄屏/协议设置截图位于 `.cache/acceptance/agent-{desktop,mobile,settings}.png`；布局与过程展示人工核对。
- DeepSeek deepseek-v4-flash 双协议真实验收通过：每种协议完成 3 个 Step、3 次工具调用（计划创建、时间读取、计划更新），并完成后续追问，共各 4 次真实模型请求。用户原配置未改动。
- 真实验收报告 `.cache/acceptance/agent-live.json`，最终复验开始于 2026-09-12T14:57:36Z；不含密钥或完整对话，测试实例已清理。首次验证和协议边界加固后的复验均成功。
- `pnpm test:docker` 最终 10 组通过：v1→v2 升级、权限与 loopback、Web、模型/SQLite、正常重启、独立卷备份恢复、两种协议工具与计划、SIGKILL 后 Step/Run interrupted、删除和日志边界。报告 `.cache/acceptance/docker.json`，最终镜像 `sha256:4d41af2a97dce364cf1e834bdf0fc56d6fe0a2a7f655a9a96910579dae2669df`；测试 project `myagent-acceptance-1789225265655` 的容器、网络和卷已清理。构建与验收日志 `.cache/acceptance/agent-docker-final.log`。

## 已知边界与接续

真实联通仅验证当前 DeepSeek 模型，不代表所有兼容服务。工具只提供最小注册和校验，审批/Policy/沙箱、文件/终端/MCP、长期记忆、自动摘要、子 Agent、Worker 仍是骨架。仅可信本机单用户。

根及 kernel/application/state/adapters/server/web/tests/scripts 局部 AGENTS 已检查并同步，中文文件职责和关键状态/取消注释已更新。其余沿途规则已检查，无需空改。未部署公共服务、未提交或推送 Git。

本机 Node 25.2.1；Docker 验证运行 Node 24.20.0 / linux/arm64，未声明其他 CPU 架构或其他模型服务商已验收。构建仍有既有 Web bundle 超过 500 kB 的提示，不影响功能检查，后续可独立做按需加载。

接续：[自主循环](../architecture/agent-loop.md)、[ADR-0004](../adr/0004-autonomous-agent-loop.md)、[API 协议](../protocols/chat-v1.md)、[当前状态](../STATUS.md)。
