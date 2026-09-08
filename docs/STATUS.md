# 当前状态

更新时间：2026-09-08。当前里程碑：工程骨架初始化。

## 已建立

- pnpm workspace：4 个应用入口、11 个库包；内部依赖显式声明。
- TypeScript strict、ESM、项目引用、Biome、Vitest、CI 校验入口。
- Web 工程占位页；server / cli / worker 的可启动提示入口。
- 包依赖边界与文档完整性检查；工程检查器的回归测试。
- 根 / 局部 AGENTS.md、产品与架构知识、迭代历史和接续入口。
- 原有设计 HTML、图表、20 处源码依据与线上托管记录保留。

## 仅有目录，没有业务实现

Runtime、Context Builder、Model Gateway、Tool System、Policy、Interaction、Execution、Session / Run / Task、记忆 / 检索 / 产物、插件 / Skill / Hook、调度 / Workflow / 子 Agent、数据库、MCP、身份与凭证。

库包当前只导出空模块，公开业务协议未冻结；config 中的运行时 YAML 尚未被加载。Web 不会调用模型或后端。其他应用启动提示不代表 HTTP 服务、SDK 或沙箱已经实现。

## 验证证据

本轮实际检查和环境见 [2026-09-08 初始化记录](history/2026-09-08-project-scaffold.md)。构建和工程测试通过只证明骨架可用，不证明任何 Agent 业务能力。

## 下一步

建议在下一次明确的功能任务中先定义 Session / Run 命令、事件与最小接口，再完成“提交输入 → 一次模型响应 → 持久化 → UI 展示”的纵向闭环。范围和验收见 [路线](roadmap.md)。本轮不实现该闭环。

## 已知约束

- 推荐 Node 24 LTS；本机默认 Node 25 的兼容情况单独记录，不等于生产环境验证。
- Git 仓库仅初始化，没有自动创建提交或关联远程。
- 研究快照不进入 Git。全新 checkout 可独立安装、检查与构建产品骨架；重建历史设计报告需另取上游快照。
