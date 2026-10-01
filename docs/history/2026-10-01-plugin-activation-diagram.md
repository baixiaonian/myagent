# 2026-10-01：插件配置到生效链路图

## 内容与源码核验

用户希望用一张图展示插件从配置到实际使用的链路。新增 `diagrams/plugin-activation.png`、`.svg`、`.drawio` 与同名生成器，保留原插件生命周期总图。

图中明确：

- 本地/Git 包清单与用户管理设置，经过候选捕获、文件及兼容性校验、准确版本确认，再由 PluginService 发布包与数据库引用。
- ChatService 创建 Run 时调用 PluginService.initialize，固定作用域、版本和组件配置；Skill/MCP/Hook 从同一版本集合接入。
- Skill 进入模型上下文，MCP 提供工具定义和实际调用，Hook 在固定生命周期运行已授权脚本；三者没有独立 Agent Loop。
- MyAgent 外部 Hook 协议兼容层尚未实现；图中的原生 Hook 可执行不能当作第三方组合插件全面兼容。
- 更新/禁用/卸载只改变新 Run，原版本引用释放后清理；资源及凭证撤销仍约束派发。

核验入口：`packages/extensions/src/plugins.ts`、`packages/application/src/plugins.ts`、`packages/application/src/chat.ts` 与 `apps/server/src/bootstrap/index.ts`。相关实现没有变更，也未安装或执行插件。

## 交付与验证

- 1500×1510 矢量画布，3000×3020 PNG；85 个 Draw.io 用户元素。
- 图源通过字体测宽；生成后使用 Draw.io 技能验证器核对 XML、几何与连线，零错误、零警告；图片另做目视检查。
- 文档链接和本次相关差异检查；未重复运行产品全量测试，因为没有产品代码改动。
- 同步 STATUS、架构页、图表说明与历史索引。已检查根及 docs 约定，模块、协议和开发规则不变，无需新增 ADR 或修改 AGENTS。
