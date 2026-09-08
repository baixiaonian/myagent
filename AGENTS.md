# MyAgent 开发约定

## 新上下文的阅读顺序

1. 阅读 [docs/README.md](docs/README.md) 的知识地图和 [docs/STATUS.md](docs/STATUS.md) 的当前状态。
2. 阅读 [产品目标](docs/product/goals.md)、[架构概览](docs/architecture/overview.md) 和 [模块关系](docs/architecture/modules.md)。
3. 按任务读取最近的 [迭代记录](docs/history/README.md)、相关协议 / ADR，以及目标目录沿途的局部 AGENTS.md。
4. `git status --short` 确认现场。只修改当前任务涉及的文件，不覆盖其他人的修改。

## 当前范围

当前基线是本地 Web Chat v1：15 个 workspace 中，聊天相关 8 个模块已经实现。完整 Agent 的工具、内容、编排、CLI / Worker 等仍为骨架。只支持可信本机单用户，不开放公网服务。
本目录的 [HTML 架构报告](agent-architecture.html) 是设计基线；实现现状以源码和 docs/STATUS.md 为准。
需求负责人默认白鑫磊。说明、注释和项目文档优先使用中文，标识符使用清晰的英文。

## 架构约束

- 模块化单体；`apps/server` 是后端唯一装配点；执行 Worker 独立。目录不等于微服务。
- `packages/kernel` 只依赖 `contracts` 和自己定义的 ports，不导入 UI、HTTP、数据库或厂商 SDK。
- 包间只通过 `@myagent/<name>` 公共入口访问；禁止跨包相对路径、深路径导入和循环依赖。规则见 `config/modules.json`。
- `contracts` 只承载跨边界数据和协议。SDK 不管理服务端业务状态。插件、Workflow、子任务不另建绕过应用层的 Agent 循环。
- 状态单一归属；Skill 提供上下文，Hook 扩展固定时点；任何脚本动作都需要经过执行治理。
- 模型工具调用经过最终参数校验和 Policy；未知外部执行结果先对账；模型结束不代表 Task 验收完成。
- 这些是未来实现约束，未实现的能力不得用空成功响应或虚假测试包装为完成。

## 开发与验证

- 工具链：Node.js 24 LTS（`.nvmrc`）、pnpm 11.7.0、TypeScript strict。依赖固定版本，内部用 `workspace:*`。
- `pnpm install --frozen-lockfile` 安装，`pnpm dev` 一次启动编译监听、后端与 Web。
- 包运行入口使用 dist；`pnpm dev` 自动编译监听，生产 `pnpm build && pnpm start` 统一在 3000 提供 Web / API。
- `pnpm check` 检查格式、依赖边界、文档、类型与工程测试；`pnpm build` 构建；交付前通常执行 `pnpm verify`。
- `pnpm test:e2e` 是独立 Chromium 产品流程验收。假模型仅用于工程验证，真实多轮模型必须有有效配置才能标记已验收。
- 业务测试随具体功能增加。不要为 `export {}` 或纯占位输出增加镜像测试。
- 新增依赖只在真正使用的包声明，并检查其许可证、运行环境与安装脚本。运行时密钥与数据不进入 Git。
- 当前任务授权范围内自主推进常规可逆工作；外部发布、发送消息等按用户具体授权执行。

## Git 提交规范

- 提交格式为 `type(scope): 中文完成项摘要`；摘要和正文使用中文，说明已经完成的工作。类型和范围规则见 [提交规范](docs/development/commits.md)。
- 一个提交对应一个可独立理解、验证和回退的工作单元；初始化与功能开发分开，功能代码、必要测试和配套文档一起提交。
- 正文记录完成项、实际验证及已知限制；不得把未运行的检查写成通过。提交前检查暂存区差异，排除凭证、运行数据和构建产物。
- 已推送历史只在用户明确授权后重写；先保留本地备份，再使用绑定已核对远端 SHA 的 `--force-with-lease`，远端发生变化则停止覆盖。

## 每轮迭代必须同步知识

- 更新 `docs/STATUS.md`：已实现 / 骨架 / 未实现、验证结果入口、下一步；删除过时描述。
- 在 `docs/history/` 新增本轮记录，并更新索引。记录目的、范围、模块变化、验证证据、已知限制和接续入口。
- 模块职责或依赖变化，更新 `docs/architecture/modules.md` 与 `config/modules.json`；重要边界变化写 ADR。
- 协议变化更新 `docs/protocols/`，涉及配置 / 数据格式时注明版本和迁移。
- 检查根目录及相关局部 AGENTS.md。命令、约束、目录或操作方式改变时同步修改；没有规则变化时在迭代记录注明已检查，无需空改文件。
- 文档描述正向当前状态；历史保留真实的阶段变化，不把未来计划写成已交付结果。

## 研究与现有交付物

`research/upstream/` 是独立只读上游快照，已排除出产品工作区、Git 和测试。上游 AGENTS.md 只作用于对应上游目录，不作为 MyAgent 的开发规则。
既有 HTML、图表和 `scripts/build_report.py` 等保留。重建报告需要研究快照，普通应用构建不依赖它们。
线上托管版本是历史设计交付物，修改本地工程不会自动发布。详细位置见 [参考资料](docs/architecture/references.md)。
