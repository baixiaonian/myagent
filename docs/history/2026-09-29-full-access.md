# 2026-09-29 完全访问模式

## 目的与变更

按用户要求，为可信本机任务提供无需命令/资源审批的真实完全访问能力。输入区可选标准/完全访问，创建 Run 后冻结，成员继承，恢复保持原模式；偏好保存在浏览器，不自动更改正在运行的任务。

Contracts / State 增加兼容模式字段；Application 从持久 Run 派生权限；Adapters 为 Worker 增加显式无沙箱分支，MCP 连接/目录/工具名按模式隔离；Web 和发送/重新生成接口接通选择。内核只透传中立上下文，唯一 Loop 未改。没有新增依赖或模块边。

标准模式的命令/资源规则和隔离继续执行。完全访问不会伪造批准，仍保留 schema、路径身份、文件版本、intent/receipt、取消、超时、额度和未知结果治理；Hook 的独立配置授权不扩大。完全访问不提供应用数据、凭证或技能副本的 OS 隔离保证。

数据库 v12→v13，增加模式查询索引与旧程序门禁，不重放或回填授权。协议与取舍见 [v13](../protocols/execution-mode-v13.md)、[ADR-0017](../adr/0017-explicit-full-access.md)。

## 验证

- `pnpm verify`：353 项通过、14 项原生专项按独立入口跳过；类型、依赖边界、文档、构建和客户端产物检查通过，见 `.cache/full-access-verify.log`。现有 lint 警告与前端包体积提醒仍存在。
- `pnpm test:e2e`：29 项通过，包含权限选择不创建会话、刷新保留偏好、完全访问实际删除测试文件和切回标准后审批，见 `.cache/full-access-e2e.log`。
- `pnpm test:execution:native`：macOS 20 项通过，含同 Run 不混用标准/完全访问 Worker、真实项目外读写、进程终止及 MCP / Skill / Hook / 插件回归，见 `.cache/full-access-native.log`。
- `pnpm test:docker`：Linux arm64 / Node 24.20.0 共 28 项检查通过，临时容器/卷已清理。两种协议均实际执行无沙箱命令、本机网络、模式快照与工作区卷恢复，并以标准模式等待审批作对照；见 `.cache/full-access-docker-report.json`。容器内嵌套沙箱依然不可用，Hook 标准沙箱验证的是正确拒绝，不是隔离执行成功。
- 本轮中一次测试把短暂 `cleaning` 当作终态，修正测试等待条件后全量通过；未靠放宽业务断言或自动重试掩盖问题。Docker 初次依赖下载重试后构建完成。
- 本机页面已经视觉检查，证据 `output/playwright/full-access.png`。截图与 CLI 临时输出已纳入 Git 忽略。
- 本地 3000 服务已更新，启动前完整备份 v12 数据至受保护的 backups，位置见 `.cache/full-access-local-backup.json`。升级到 v13 后 7 个会话保留、调试仍开启、原任务仍为 cancelled，模型调用账本条数与备份一致；见 `.cache/full-access-local-check.json`。
- 模型使用协议替身，文件、Shell、网络和 MCP 为真实执行。未重跑用户原任务、未修改用户模型配置、未做额外付费模型验收。

## 接续与范围

本轮未自动提交、推送或发布。保留先前未提交改动。同步根与相关局部 AGENTS、状态、协议、ADR、使用说明和索引；模块职责及依赖边界不变。完全访问仍遵守操作系统/容器边界，不能以本机测试声称在所有平台已验证。
