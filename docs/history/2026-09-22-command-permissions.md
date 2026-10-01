# 2026-09-22：命令级权限控制

## 目的与范围

为 exec_command 增加独立于资源沙箱的启动权限，保持模型自主 Loop。明确低风险读取自动，其余默认询问；用户/项目规则取 deny > prompt > allow。批准仅本次完整调用，交互程序后续输入不逐次审批，脚本内部不做子进程拦截。

## 完成项

- contracts 增加规则/配置/分析 DTO，kernel 增加端口与纯规则组合，adapters 使用 WASM AST、可执行文件身份及与 Worker 相同的 PATH；语法错误和服务缺失不降级。
- application 管理文件版本、可信确认和提交恢复，ToolService 组合资源与命令审批，并在资源锁、并发槽、Worker 就绪后复核。
- Server/SDK 新增配置与静态检查 API；Web 独立设置支持表单/JSON、版本变化提示及规则测试；审批卡展示完整命令、实际目录、原因和输入边界。
- SQLite v4→v5：新集合 commandFiles 与索引、旧程序版本门禁；旧授权仍仅表示资源，历史不补造命令批准。
- 中文注释及根/相关局部 AGENTS 已同步。无新内部依赖边，模块清单职责更新；Loop、MCP 调用、write_stdin 权限流程不改变。其他内容/编排/CLI 模块继续为骨架。

## 验证证据

- `pnpm verify`：171 项通过，6 项原生专项按约定在独立命令运行；格式、依赖边界、文档、类型、生产构建与客户端凭证边界检查通过。日志 `.cache/command-policy-verify.log`。
- `pnpm test:e2e`：15 条通过，含配置/审批/外部文件变更与草稿保护；日志 `.cache/command-policy-e2e.log`，界面截图 `.cache/tool-execution/command-settings.png`。
- `pnpm test:execution:native`：macOS 10 项通过，临时目录实际删除、批准前无副作用、越界读取拒绝、交互输入不再审批；日志 `.cache/command-policy-native.log`。
- Docker linux/arm64、Node 24.20.0：12 项通过，生产仅运行时依赖仍可加载 WASM，v1→v5（含 v4→v5）迁移、规则重启/备份恢复、双协议工具闭环及 SIGKILL 恢复。最终加固镜像验收通过，容器/网络/测试卷已清理；报告 `.cache/command-policy-docker.log`、`.cache/acceptance/docker.json`。

测试只使用自身临时目录、卷和协议替身，不使用用户密钥或项目数据。新增依赖的原生安装脚本已禁用。构建仍有既有 bundle 大小提示和 2 条既有 MCP CSS specificity 警告；不会把这些提示写成执行功能失败。

## 边界与接续

默认清单保守，未知选项、Git、脚本、解释器、复杂语法可能需要较多批准；设置页允许用户通过显式规则减少询问。放行解释器/脚本表示信任其后续行为，不承诺命令规则拦截全部子进程。

跨外部编辑器的检查/rename、策略复核/实际执行存在 OS 竞态窗口；已有程序不因新规则自动撤销。既有未提交改动保留，没有自动提交、推送或部署，也未新增真实模型验收。未启动用户数据目录中的长期服务；本机产品仍通过 `pnpm dev` 或 `pnpm build && pnpm start` 启动。

接续入口：[命令协议](../protocols/commands-v5.md)、[使用说明](../development/commands.md)、[ADR-0009](../adr/0009-command-permissions.md)。
