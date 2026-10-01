# 插件使用与维护

打开侧栏“插件”。有当前项目时默认项目级；否则选择用户级或选定项目。输入本地目录，或公开 HTTPS Git 地址、可选分支/标签/提交及包子目录，点击“检查并预览安装”。预览不会执行插件。

核对组件、包哈希、作用域、Hook 的写入/网络权限及兼容报告。明确排除不支持组件后重新预览。“确认版本与权限并启用”使新任务可用；取消启用勾选可仅安装。管理页可启停、检查更新、回退上一内容版本、设置 MCP 提供方式与凭证、卸载或恢复用户级继承。MCP 连接失败需检查依赖、认证或重新连接，不能以“已安装”当作可用证据。

试用仓库 `plugins/report-assistant/`：安装到隔离项目，发送“请按报告助手约定查询样例销售数据，生成中文报告到 reports/final.md，并读回核验”。模型可自行加载 Skill 和搜索 MCP；业务授权按审批卡确认。样例收入为静态测试数据 2000，并非真实账户。路径检查 Hook 会拒绝 reports 外的报告写入。

本地源目录修改后点击检查更新；旧任务仍使用原快照。回退预览原内容版本，组件选择/认证需再次核对。卸载若显示等待清理，可查看仍占用旧版本的 Run，必要时停止。取消、未知副作用和恢复按原执行系统处理，不盲目重放。

公开包已有一次安装启用与任务实测：[Build Web Data Visualization 验收](../history/2026-10-01-public-plugin-live.md)。来源为 `https://github.com/openai/plugins.git`，包子目录 `plugins/build-web-data-visualization`，固定提交 `5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f`。该包包含 18 个 Skill，不包含 MCP/Hook；通过的任务与浏览器检查不能替代第三方 MCP/Hook 或其他模型协议的验收。保留的验收项目可直接在侧栏打开，再在插件设置中选择对应项目查看已启用状态。另对包含三类组件的 sqlew 做了[真实安装预览](../history/2026-10-01-public-plugin-composite-check.md)：外部 Hook 格式阻断，尚不能整体启用；仅识别到 MCP 声明不能作为握手或调用通过证据。

Git 仅支持公开 HTTPS，不传宿主密钥或私有仓库令牌。私有仓库先自行克隆再本地安装。系统不运行安装脚本，不自动安装 node/python 依赖；缺少运行环境会在真实连接/执行时显示错误。

备份须在关闭服务后同时复制数据目录的 state.db、plugin-packages、原有 Skill/Hook 快照和凭证目录；不要只备份数据库。升级前保留完整备份。容器安装源目录必须是后端可读的容器路径（可只读挂载），已发布包保存在 /data，重启从数据卷恢复。运行镜像包含 Git/CA；嵌套沙箱探测失败继续拒绝执行。

验证命令：`pnpm test:plugins`、`pnpm test:execution:native`、`pnpm test:e2e`、`pnpm test:docker`。`pnpm test:plugins:live` 只在得到真实模型授权后运行，用独立临时实例验证双协议；不修改原模型配置。报告位于 `.cache/acceptance/plugins-live.json`。
