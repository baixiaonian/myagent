# Skill 使用与维护

## 快速开始

1. 在 ~/MyAgent/Skills/report/ 创建 SKILL.md，或在“技能 → 来源目录”添加现有单包/集合目录。项目专用技能放在项目根 .myagent/skills/。
2. 使用如下最小格式，name 必须与目录名一致：

```markdown
---
name: report
description: 汇总本项目数据并生成报告时使用。
---
先读取 references/format.md，再使用 scripts/ 下已有脚本生成报告。
```

3. 可增加 references/、scripts/、assets/；相对路径基于技能根目录。模型实际使用的是只读包副本，产物写入项目目录。
4. 自然描述任务可由模型自行选择；明确指定可用输入区“技能”按钮或 $ 补全。标签只针对本轮，下一条消息重新选择。

“技能”设置可查看主说明和资源、筛选作用域、启停、选择本机目录、改作用域或移除来源。目录指后端所在机器；Docker 应挂载来源卷，不是浏览器上传本机文件。原生窗口不可用可输入路径。

## 更新与故障

- 使用本地编辑器修改文件，页面轮询/重新扫描可看到变化；下个 Run 使用新版本。当前 Run 保留已加载快照，需终止时使用“停止”。
- 仅允许显式调用：agents/openai.yaml 配置 policy.allow_implicit_invocation: false；不会自动安装 dependencies，也不把 allowed-tools 当作授权。
- 重名技能按来源分别选择；非法 YAML/编码、目录名不匹配、空正文和资源链接明确报错。
- 技能目录不可用不会拖垮其他技能；加载过程中主说明变更需下一轮重新选择。
- 大文件请拆出参考资料。技能正文占用过多时查看上下文明细，调整模型容量；正文不会被静默截断。
- 缺少运行依赖时工具返回真实错误，按现有权限自行安装；不能把 Skill 启用理解为已经批准 Shell 或联网。

## 配置、备份和清理

MYAGENT_SKILL_ROOT 覆盖用户来源；MYAGENT_SKILL_FILE_BYTES、MYAGENT_SKILL_PACKAGE_BYTES、MYAGENT_SKILL_FILES 覆盖默认 20 MiB/100 MiB/10000。数值必须是正整数。

数据库与 skill-packages 一起备份，另行备份用户和项目技能源目录。Docker 包含 data/workspaces/skills 三个独立卷；恢复时保持数据挂载路径。临时运行副本不需要备份，可以从持久包重建；不要在运行时手动修改副本。

删除会话不删除技能文件，移除来源不删除原目录。活动进程/未知副作用存在时，包清理会延迟；处理完恢复核对后在下次启动或会话清理时回收。

## 验证

- pnpm test:skills：文件、目录、持久化、完整输入、压缩、取消及双协议 HTTP 替身。
- pnpm test:e2e：设置、选择、IME、来源管理与刷新恢复。
- pnpm test:execution:native：包括真实 macOS/Linux 技能脚本只读隔离专项。
- pnpm test:docker：生产打包、v8 迁移、技能卷与快照恢复；嵌套隔离不可用仍拒绝裸执行。
- pnpm test:skills:live：只读已有授权连接，在临时环境分别验收两种协议，不修改原配置。命令会产生真实模型费用，不进 CI。

仍未实现：Git/远程安装、编辑器、市场、自动技能生成、Hook 与插件执行生命周期。
