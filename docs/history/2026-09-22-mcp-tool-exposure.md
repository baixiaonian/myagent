# 2026-09-22：按 MCP 服务配置工具提供方式

## 目的与范围

支持用户逐个 MCP 服务选择按需加载或直接提供，默认全部按需。不改变自主 Loop、执行审批和 MCP 传输；不实现跨 Run 工具加载缓存。

## 模块变化

- contracts 增加可选 toolExposure 枚举；旧文件和记录缺省 deferred。
- application 统一校验、配置版本、旧 API 兼容和执行前定义快照。direct 提供全部有效定义，search_tools 只搜索 deferred；定义可见性不授予执行权限。
- server 旧连接接口接受新枚举，管理文件接口仍沿原文件流程。
- Web 表单添加工具提供方式，展开服务可查看已保存方式，JSON 编辑与刷新保持一致。
- SQLite v4 无 DDL 变化；未增加 workspace 依赖边；模型适配器与 Loop 未新增业务分支。

## 验证

- `pnpm verify` 通过：115 项测试通过、5 项原生用例按独立运行规则跳过，格式、类型、模块边界、文档、构建与产物凭证检查通过。报告 `.cache/mcp-tool-exposure-verify.log`。
- `pnpm test:e2e` 12 条通过，覆盖默认选项、表单写 direct、JSON 改回 deferred、重新编辑及刷新恢复，保留聊天/审批/恢复回归。报告 `.cache/mcp-tool-exposure-e2e.log`。
- 新增 `tests/execution/mcp-exposure.test.ts` 7 项集成测试：混合服务与超过五个直接定义、默认值与项目覆盖、待确认、版本切换/禁用、审批、旧 API/持久化和重启；两种模型协议均通过实际 loopback HTTP 验证首个及后续请求携带全部直接定义，业务调用前仍暂停审批。
- `git diff --check` 通过。原有两处 CSS 优先级提示与前端大包提示仍存在，本轮没有新增同类警告。
- 本次使用本地模型/MCP 协议替身，没有新增真实模型、外部生产 MCP、原生沙箱或 Docker 验收；对应历史证据见此前迭代，不将其算成本轮复验。

## 边界与接续

直接提供的定义仍计入整体上下文预算，超限明确失败；不承诺任意数量工具都能装入模型输入。配置变更按原逻辑关闭旧连接，旧版本调用拒绝派发。已检查根及 contracts、application、adapters、Web、server、tests、docs 局部约定，更新根与 application 对工具提供方式的规则，其余无新规则。所有改动留在本地，未提交推送。

实现入口：packages/application/src/tools.ts、mcp-manager.ts；协议见 [项目/MCP v4](../protocols/projects-mcp-v4.md)，决策见 [ADR 0007](../adr/0007-mcp-tool-exposure.md)。
