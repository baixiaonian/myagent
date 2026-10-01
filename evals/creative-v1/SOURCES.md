# 来源、版本与材料性质

核验日期：2026-09-29。所有8题的任务提示、业务场景和评分细则均为本轮自建；不是从公开benchmark抽取的原题。公开来源提供事实、源码或方法依据。所有所需输入已随包保存，执行任务无需实时访问外网。

| 内容 | 来源与冻结方式 | 许可与处理 |
|---|---|---|
| 技术题 | [SQLite WAL](https://sqlite.org/wal.html)、[隔离](https://sqlite.org/isolation.html)、[Python sqlite3](https://docs.python.org/3/library/sqlite3.html) | 自写事实卡；SQLite代码与文档[公有领域](https://sqlite.org/copyright.html)；没有复制整篇第三方文章 |
| 财经题 | [微软FY2025年度利润表](https://www.microsoft.com/en-us/Investor/earnings/FY-2025-Q4/income-statements)、[现金流量表](https://www.microsoft.com/en-us/Investor/earnings/FY-2025-Q4/cash-flows) | 只转录年度数值事实与单位，CSV冻结；没有转载财报全文 |
| 代码题 | [ItsDangerous 固定提交](https://github.com/pallets/itsdangerous/tree/096c8d42545d3b68ea21a4f890fb2b2d8979c0bd) | BSD-3-Clause，保留 LICENSE.txt；上游原样src/tests/pyproject，详见 [获取清单](UPSTREAM.json) |
| 教学题 | [MDN microtask guide](https://developer.mozilla.org/en-US/docs/Web/API/HTML_DOM_API/Microtask_guide) | 自写概念卡和原创两段代码，不复制文章 |
| 梳理/长篇/产品/图解 | 本评测原创虚构资料 | 机构、人物、日志、预算与数据均为测试场景，不声称是真实客户或用户研究 |
| 评分方法 | [WritingBench](https://github.com/X-PLUG/WritingBench)、[LongWriter / LongBench-Write](https://github.com/THUDM/LongWriter)、[CodeWikiBench](https://github.com/FSoft-AI4Code/CodeWikiBench)、[WebGen-Bench](https://github.com/mnluzimu/WebGen-Bench) | 借鉴逐题rubric、长文质量、源码证据和实际浏览器验收方法；未复制这些数据集，分数不能与其排行榜直接比较 |

源码原始注释及许可证保持不变。`checksums.json`逐文件记录任务、输入、裁判和评分协议的SHA256；不是数字签名，也不能抵御评价者同时修改文件与哈希表，只用于发现意外漂移。重新发布必须更新版本。

公开题可能存在训练数据污染；冻结源码避免版本漂移，不能证明模型从未见过它。此套适合产品回归和诊断，不是对通用智能能力的保密考试。
