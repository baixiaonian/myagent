# 历史 HTML 报告的内容构建模块：接收 section / table / refs 渲染函数，组织技术选型和目录等章节。
# 只返回报告片段，不启动产品、不读取用户凭证；其中规划描述属于原设计阶段。
# 渲染器由主报告注入，内容模块不自行访问网络；保持表格与章节样式一致。
def build_details(section, table, refs):
    def doc(label, url):
        return f'<a href="{url}" target="_blank" rel="noreferrer">{label} ↗</a>'
    tech = [
        ('语言与工程','TypeScript strict + Node.js 受支持 LTS；pnpm workspace','一套语言覆盖产品与内核；状态用可辨识联合类型。开工时锁定兼容的稳定版本与依赖。','CPU 密集工作进入 Worker；平台隔离需求通过原生执行适配器增加。',doc('Node 生命周期','https://nodejs.org/en/about/previous-releases')),
        ('运行内核','自有 Runtime + 显式依赖注入 + AsyncIterable / AbortSignal','维护一个循环与状态机；核心逻辑通过 FakeModel、FakeClock 验证。','自己掌握运行语义，借鉴上游契约；不将整个上游产品作为内核依赖。',refs('P1','C1','D1')),
        ('Web 工作台','React + Vite + SDK 事件投影','页面包含会话、任务、工具过程、人工交互、产物和设置。UI 状态与服务端业务状态分开。','当前工作台无需服务端渲染；公开内容展示站可独立演进。',doc('Vite','https://vite.dev/guide/')),
        ('后端入口','Fastify + JSON Schema 路由契约','框架承担路由、认证、限流和流式连接；收到请求后转为应用命令。','替换框架只影响 apps/server；内核不读取 HTTP request。',doc('Fastify','https://fastify.dev/docs/latest/')),
        ('类型与校验','JSON Schema 作为边界格式；Ajv 校验；DTO 从同一 Schema 生成','工具、事件、配置和插件清单采用同一来源，避免类型和校验规则漂移。','厂商只支持 Schema 子集时，由适配器转换，保留工具最终校验。',doc('Ajv','https://ajv.js.org/guide/getting-started.html')),
        ('客户端通信','HTTP 命令 + SSE 事件；本地 Worker 使用版本化 IPC 信封','操作走 POST；进度按 sessionId + seq 补读。任务运行不依赖浏览器连接。','双向音视频或高频终端输入按需增加 WebSocket；复用应用命令语义。',refs('C4')),
        ('模型接入','ModelPort + 厂商官方 SDK；按账号接入 OpenAI / Anthropic / DeepSeek','统一消息与流事件；能力表声明工具、图片、结构化输出、上下文限制。','OpenAI-compatible 不代表完全兼容；用固定响应验证协议，模型选择由真实任务评测决定。',refs('P5','D2')),
        ('结构化存储','SQLite WAL + better-sqlite3 + Drizzle；经 StatePort 访问','短事务提交状态和持久事件，迁移文件可审查；事务内不等待网络或模型。','多实例时适配 PostgreSQL、锁与租约；SQL 方言和迁移需要验证，不能只改连接串。',doc('Drizzle SQLite','https://orm.drizzle.team/docs/sqlite/get-started-sqlite')),
        ('内容与全文检索','文件 blob + SQLite 元数据 + FTS5；中文预分词','保留 sourceId / revision / chunkId / offset；索引可重建，命中结果能回到原文。','中文分词器用自有检索集选型；trigram 可补子串查询，不能当成语义理解。',doc('SQLite FTS5','https://www.sqlite.org/fts5.html')),
        ('语义检索','EmbeddingPort + VectorIndexPort；小规模存向量并精确检索','混合关键词与向量召回；权限过滤后合并排序。保存 embedding 模型与维度版本。','规模、延迟或共享写入超出实测目标后切 PostgreSQL + pgvector；换 embedding 要重建索引。',doc('pgvector','https://github.com/pgvector/pgvector')),
        ('MCP 与连接器','官方 TypeScript MCP SDK；本地 stdio、远端 Streamable HTTP','外部工具映射到 ToolRegistry，保留命名空间、连接状态、版本和权限范围。','认证、超时与取消由适配器处理；工具目录只暴露当前可用且授权的能力。',doc('MCP SDK','https://modelcontextprotocol.io/docs/2026-07-28/sdk')),
        ('Shell / 浏览器','独立 Worker + 受限容器 + Playwright','工作区路径与挂载保持一致；浏览器独立上下文，截图和结果登记为产物。','trusted 本地模式使用用户权限；容器限制挂载和网络，不挂 Docker socket；子进程本身不是沙箱。',doc('Docker','https://docs.docker.com/engine/security/')+' '+doc('Playwright','https://playwright.dev/docs/intro')),
        ('插件系统','自有轻量 SPI + manifest + activate / dispose；启动装配','可信内置扩展显式注册，第三方扩展通过受限 Worker 与能力代理访问资源。','借鉴 Cordis 生命周期；确需运行中动态替换后再增加复杂插件容器。',refs('D8','D10')),
        ('计划与调度','Task 保存可变计划；版本化 DAG 保存固定流程；SQLite jobs 表','保存 dueAt、时区、attempt、lease 和幂等键；定时器只唤醒扫描，重启后补查到期工作。','跨机耐久流程可经 OrchestrationPort 接入专门引擎；权限、预算和任务语义统一。','本方案设计'),
        ('日志与质量','Pino 结构化日志 + OpenTelemetry Trace / Metrics 接口 + 任务评测集','按 runId 串起模型、工具与等待；内容脱敏；关键审计独立写入状态库。','本地文件起步，团队部署导出 OTLP；费用区分实际用量和按价格表版本计算的估算。',doc('OpenTelemetry JS','https://opentelemetry.io/docs/languages/js/')),
        ('工程验证','Vitest + Playwright + 架构依赖检查；FakeModel / Tool / Clock','单测验证状态与预算，契约测试验证适配器，集成测试验证取消、恢复与重复消息。','评测单独统计质量、成本和耗时；新模型或依赖版本通过固定任务集后再升级。',doc('Vitest','https://vitest.dev/guide/')+' '+doc('Playwright','https://playwright.dev/docs/intro')),
    ]
    a = section(10,'technology','技术选型：给每个模块一个明确落点','推荐组合面向个人与小团队的自有 Agent；选型理由与替换条件均为本方案判断。',table(['位置','推荐方案','选择理由 / 使用方式','边界 / 替换条件','一手依据'],tech)+'''
<div class="decision"><h3>自研控制逻辑，复用成熟基础设施。</h3><p>自己掌握运行循环、状态语义、权限、上下文策略与扩展协议。HTTP、数据库驱动、模型 SDK、MCP 与浏览器自动化复用成熟实现。这使后续替换某个库时，业务行为仍由你控制。</p><p>以上为目标选型，尚未安装和联调。开工时锁定稳定版本，提交 lockfile，以真实工具、恢复测试和任务评测验证；性能指标由测量确定。</p></div>''')
    relations = [
        ('启动 / 控制任务','POST /v1/sessions/{id}/runs；POST /v1/runs/{id}/steer、cancel、resume','命令带 clientRequestId；202 返回 runId / status / cursor；版本冲突返回当前 revision。'),
        ('人工交互','POST /v1/interactions/{id}/responses','带 expectedRevision 和请求 ID；回答进入 Inbox，审批绑定确切 intent；拒绝也有明确后续状态。'),
        ('事件订阅','GET /v1/sessions/{id}/events?after={seq}','快照附带一致 watermark；只补 watermark 后事件，避免快照与订阅间隙漏消息。'),
        ('核心关系','Workspace → Session → Branch；Task → Run → Step → Invocation','所有引用携带工作区归属；模型重试独立 attemptId；事件唯一键 sessionId + seq。'),
        ('审批与执行','Invocation → Intent / Approval / ExecutionReceipt','最终参数摘要、策略版本、effect、资源 revision 和 deadline 组成授权；可到期、撤回。'),
        ('内容关系','Source → Revision → Chunk；Artifact → Revision → Blob；Memory → SourceRef','blob 先临时写入并原子落位，再提交元数据；未引用 blob 可回收，引用存在时不可先删内容。'),
    ]
    b = section(11,'deployment','部署与数据协议：从设计接到工程','先部署一套后端和执行环境，保留横向扩容所需的接口。','''
<div class="grid two"><article class="card"><h3>本地 / 单实例部署</h3><p>浏览器或 CLI → loopback HTTP 服务 → 应用服务与内核 → 受限执行 Worker。SQLite 和 blob 位于仓库外的 ~/.myagent/，数据目录按操作系统用户隔离。</p><p>local profile 使用本地身份和启动凭证；远程 server profile 增加 TLS、OIDC、租户/工作区校验与配额。命令、SSE、文件上传和下载执行相同的权限检查。</p><p>备份数据库和内容清单需采用一致快照；迁移前备份，事件通过 schemaVersion 兼容读取。</p></article><article class="card"><h3>向多实例演进</h3><p>优先拆执行 Worker，随后将共享状态切到 PostgreSQL、blob 切到对象存储。Run 使用租约和递增 fencing token，旧运行者的迟到结果只记账，不覆盖新状态。</p><p>状态更新与 outbox 同事务，分发器至少一次投递，客户端去重。多机写同一工作区需要执行端验证租约或隔离工作区；数据库 fencing 本身无法阻止外部副作用。</p><p>扩容前验证迁移、进程退出、断网和回执对账。接口提供演进路径，仍需要这些工程验证。</p></article></div>
'''+table(['协议 / 数据关系','建议的具体形式','可靠性要求'],relations)+'''
<div class="callout"><h3>重试、取消和完成是三种不同的判断。</h3><p>模型可重试错误采用有上限退避并记录 attempt；中断流的部分文本不能和新尝试直接拼成完整回答。读工具可按策略重试，写工具需幂等或回执对账。cancel 先停止派发，再取消子进程或远端请求，已发生的动作仍需结算。Run 正常结束只表示这次执行结束，Task 完成由验收标准和产物证据决定。</p></div>''')
    return [a,b]
