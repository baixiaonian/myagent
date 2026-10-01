# MyAgent 创作评测 v1：8题可直接执行包

按“2篇文章＋材料梳理＋长篇文档＋代码库文档＋产品HTML＋教学HTML＋图解HTML”组成8个独立任务，共5份Markdown、3份HTML。每题含完整提示词、本地输入、关键事实、100分细则与验收步骤。文章两题分别为计算机技术与财经。

这是自建业务回归集，素材来自核验过的公开事实、固定开源代码和原创虚构业务情境。它不是8个大规模公开数据集，也不冒充现有榜单成绩。[来源与版本](SOURCES.md)区分了公开事实和合成资料。

| ID | 任务与可复制提示 | 交付 | 输入与难点 | 评分重点 |
|---|---|---|---|---|
| 01 | [SQLite WAL锁冲突技术文章](cases/01-tech-article/PROMPT.md) | article.md；2200–3200字 | 官方事实卡；机制与可运行示例 | 原理30、诊断25、示例20、组织15、引用10 |
| 02 | [微软FY2025现金流分析](cases/02-finance-article/PROMPT.md) | article.md；2000–3000字 | 两年度真实财务CSV；独立复算与因果边界 | 数据35、分析25、论点20、表达10、引用10 |
| 03 | [星桥试点进展简报](cases/03-material-synthesis/PROMPT.md) | brief.md；1300–2000字 | 7份材料；旧计划/新决策、验收与预算冲突 | 事实35、取舍20、指标15、行动20、阅读10 |
| 04 | [图书馆平台实施蓝图](cases/04-long-document/PROMPT.md) | blueprint.md；10000–14000字 | 12份材料；18项需求、预算/人力/范围跨章一致 | 约束25、深度25、长文20、量化15、验收15 |
| 05 | [ItsDangerous源码导读](cases/05-repository-docs/PROMPT.md) | guide.md；3000–4500字 | 固定2.2.0源码与测试；真实调用链/安全边界 | 事实35、链路25、验证20、阅读10、引用10 |
| 06 | [稍后读工作台原型](cases/06-product-html/PROMPT.md) | index.html | 访谈＋6条种子记录；操作/状态/刷新保留 | 闭环30、体验25、视觉20、适配15、数据10 |
| 07 | [事件循环教学演示](cases/07-teaching-html/PROMPT.md) | index.html | 两个代码样例；逐步/播放/暂停/重置/练习 | 语义35、交互25、教学20、视觉10、适配10 |
| 08 | [文档发布五种图解](cases/08-diagram-html/PROMPT.md) | index.html | 系统事实＋指标＋时间线；架构/流程/时间线/信息图/对比图 | 准确35、图解25、视觉20、导航10、完整10 |

图解是一个综合任务，不拆成五题。字数使用本包定义的近似计数，非token。长文题测持续写作与一致性，不保证它一定触发当前200k窗口的上下文压缩。

## 直接开始

在MyAgent仓库根执行（仅准备文件，无付费调用）：

```bash
python3 evals/creative-v1/tools/suite.py validate
python3 evals/creative-v1/tools/suite.py prepare 01-tech-article "$HOME/MyAgent/Workspaces/eval-tech-01"
```

在MyAgent里新建对话，选择生成的 `eval-tech-01` 项目目录，发送：

```text
请阅读工作区 PROMPT.md，按要求完成任务并保存实际作品。
```

每题换一个新目录；ID见表。prepare只复制本题PROMPT与inputs，拒绝覆盖已存在目录。默认离线材料已齐，不需要连MCP、下载数据或安装额外模型。代码题通过PYTHONPATH使用随附源码。需要执行命令的权限按相同测试配置处理并记录人工等待。

**不要直接把本仓库或评测包目录作为被测项目**，里面有裁判答案。若被测系统允许任意宿主文件访问，严格盲测应使用只挂载单题目录的隔离实例；普通目录隔离不能代替权限隔离。详见[评分协议](SCORING.md)。

## 作品完成后怎么评分

```bash
python3 evals/creative-v1/tools/suite.py check 01-tech-article "$HOME/MyAgent/Workspaces/eval-tech-01"
python3 evals/creative-v1/tools/suite.py template 01-tech-article /tmp/creative-review-01.json
```

1. 预检返回产物SHA256、输入变化、格式和长度提示；它不会因有文件就判质量通过。
2. 裁判阅读[统一方法](SCORING.md)、该题 `graders/<ID>.md`、任务、输入和真实作品；财经另有[程序计算金标准](graders/finance-gold.json)。按[裁判提示词](JUDGE_PROMPT.md)填写评分模板。
3. HTML在独立干净浏览器打开，按逐题操作步骤检查，保存1440×900和390×844截图；没有这些证据暂不评分。
4. 将预检SHA256写入评分文件，逐维度填0–4分和证据，再汇总：

```bash
python3 evals/creative-v1/tools/suite.py score 01-tech-article "$HOME/MyAgent/Workspaces/eval-tech-01" /tmp/creative-review-01.json
```

每题满分100，80分以上且机械/关键条件通过、首维度至少3分才通过。缺失评分、产物变化或HTML未实测会拒绝汇总。批量记录使用[结果登记模板](results-template.csv)，费用与质量分别报告；未知费用保持空值。

评分和查看可以人工完成，也可以把独立裁判提示交给模型；本包没有自动调用裁判模型或自动运行MyAgent的功能。仅prepare/check/template/score/validate是离线脚本能力。

## 运行策略

先8题各1次做问题定位，再每题3次做稳定性回归。冻结模型、系统提示、工具、权限、记忆与扩展配置。每次从相同原始输入开始，保留全部失败。将运行限制/费用预算在实际开跑前明确，准备本包不代表已经获得任意付费调用授权。

统一记录主Agent、成员和摘要的实际请求数/用量、缓存命中、墙钟时间、人工等待、已知费用/未计价次数与Trace。评分费用单列。单题成败不代表某种写作能力的总体结论；8题适合回归与发现问题，尚不够形成可信的通用榜单。

## 目录

- `cases/`：候选可见提示与素材。
- `graders/`：裁判专用事实、细则与操作清单。
- `suite.json`：题目索引和版本；`checksums.json`：冻结内容哈希。
- `UPSTREAM.json`：第三方固定提交及原归档哈希；许可证保留在源码输入中。
- `tools/suite.py`：零外部依赖的Python3离线工具。
- `tools/test_suite.py`：工具防泄漏、评分证据、输入完整性等回归测试。
- [验证记录](VALIDATION.md)：材料与工具实际检查；不表示被测Agent已通过。

JSON不支持注释，字段定义由本页与评分协议说明。新增任务或变更题目须升级版本并重建哈希；已有得分不自动沿用。
