# 历史架构报告生成器：读取 research/upstream 只读快照，固定源码 SHA / 行号并输出 HTML 与来源清单。
# 运行会重建历史研究交付物；普通聊天构建不依赖它，本轮注释维护不执行报告重建。
from pathlib import Path
import html, json, subprocess, re

ROOT = Path(__file__).resolve().parents[1]
repos = {"pi": "earendil-works/pi", "codex": "openai/codex", "deepseek-harness": "deepseek-ai/deepseek-harness"}
snapshots = {}
# 先固定每个参考仓库当前 SHA，后续源码链接绑定该版本，避免漂移到最新分支。
for key, repo in repos.items():
    sha = subprocess.check_output(["git", "-C", str(ROOT / 'research/upstream' / key), "rev-parse", "HEAD"], text=True).strip()
    snapshots[key] = {"repo": repo, "sha": sha}

sources = [
('P1','pi','packages/agent/src/agent-loop.ts',158,308,'循环与模型边界','runLoop 处理工具回合、steering、follow-up；transformContext 先于 convertToLlm。'),
('P2','pi','packages/agent/src/agent-loop.ts',366,426,'截断参数与并发','输出长度截断时不执行工具；工具 executionMode 可以要求串行。'),
('P3','pi','packages/coding-agent/src/core/session-manager.ts',840,872,'树状会话','会话条目通过 id / parentId 构成分支；上下文从当前分支生成。'),
('P4','pi','packages/agent/test/agent-loop.test.ts',444,505,'Hook 修改参数的边界','测试明确允许 beforeToolCall 修改后的参数直接执行；本方案改为最终参数重新校验。'),
('P5','pi','packages/ai/src/types.ts',1,90,'模型协议与厂商分离','Api、ProviderId 等类型将协议类别与模型提供方区分。'),
('C1','codex','codex-rs/core/src/session/turn.rs',335,395,'每轮冻结执行视图','同一步的上下文、工具暴露与工具执行共享 StepContext。'),
('C2','codex','codex-rs/core/src/tools/router.rs',73,145,'工具路由','ToolRouter 持有模型可见规格和对应可执行注册表。'),
('C3','codex','codex-rs/core/src/tools/orchestrator.rs',1,145,'执行治理','ToolOrchestrator 集中处理审批、沙箱选择及执行尝试。'),
('C4','codex','codex-rs/app-server/README.md',19,107,'前后端协议','双向协议、Thread / Turn / Item、流式通知，以及有界队列与背压。'),
('C5','codex','codex-rs/rollout/src/recorder.rs',90,118,'会话血缘','记录会话来源、父任务、fork 位置及动态工具等元数据。'),
('D1','deepseek-harness','packages/core/agent-loop/src/agent.ts',258,343,'运行状态与结束原因','每轮有 turn / step 边界、取消信号和结构化结束原因。'),
('D2','deepseek-harness','packages/core/agent-loop/src/agent.ts',485,587,'冻结模型请求','组装请求、记录请求头、绑定适配器并冻结请求对象。'),
('D3','deepseek-harness','packages/core/tools/src/index.ts',1091,1115,'单向收紧的 guard','后置 guard 允许拒绝，其他 guard 不能把既有拒绝改成允许。'),
('D4','deepseek-harness','packages/core/agent-loop/src/tool-calls.ts',1,101,'有界并发与顺序归并','独占调用形成屏障；并行调用使用有界池；结果按模型顺序提交。'),
('D5','deepseek-harness','packages/core/session/src/repair.ts',1,75,'崩溃恢复语义','区分 TOOL_NOT_STARTED 和 TOOL_OUTCOME_UNKNOWN，补齐未闭合记录。'),
('D6','deepseek-harness','packages/core/session/src/index.ts',1,96,'会话事件与持久化','追加式会话日志、派生历史及独立的 flush 持久化检查点。'),
('D7','deepseek-harness','packages/skill/skill/src/index.ts',1,112,'Skill 目录与提供者','接口、实际提供者、摘要目录与按需正文读取分离。'),
('D8','deepseek-harness','vendor/cordis/src/service.ts',1,67,'服务生命周期','注册服务与所属 fiber 绑定，卸载时自动清理。'),
('D9','deepseek-harness','packages/hooks/hook-protocol/src/runner.ts',1,85,'命令 Hook 执行','命令 Hook 走 ShellExecutor，携带取消信号与超时。'),
('D10','deepseek-harness','docs/architecture.md',7,29,'组合方式','服务、事件、可撤销效果及按 profile / bundle 组装的插件树。'),
]
source_map = {}
# 逐条校验行号存在，再构造固定提交链接；不把未经定位的说明包装成源码证据。
for sid, key, path, start, end, title, finding in sources:
    lines = (ROOT/'research/upstream'/key/path).read_text().splitlines()
    assert 1 <= start <= end <= len(lines), (sid, len(lines))
    s = snapshots[key]
    source_map[sid] = {"id":sid,"repository":key,"path":path,"start":start,"end":end,"title":title,"finding":finding,"sha":s['sha'],"url":f"https://github.com/{s['repo']}/blob/{s['sha']}/{path}#L{start}-L{end}"}
(ROOT/'research/source-manifest.json').write_text(json.dumps({"retrieved":"2026-09-07","snapshots":snapshots,"sources":list(source_map.values())},ensure_ascii=False,indent=2))

# 渲染来源编号与固定链接，章节通过这些编号关联前面已经校验的源码。
def refs(*ids):
    return ' '.join(f'<a class="ref" href="{source_map[i]["url"]}" target="_blank" rel="noreferrer">{i} ↗</a>' for i in ids)
def table(headers, rows):
    return '<div class="table-wrap"><table><thead><tr>'+''.join(f'<th>{x}</th>' for x in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join(f'<td>{x}</td>' for x in row)+'</tr>' for row in rows)+'</tbody></table></div>'
def section(n, id, title, lead, body):
    return f'<section id="{id}"><div class="section-head"><span class="num">{n:02d}</span><div><h2>{title}</h2><p>{lead}</p></div></div>{body}</section>'

sections = []
sections.append(section(1,'decision','先把全貌定下来','推荐：TypeScript 模块化单体，内核稳定，能力通过接口接入。', '''
<div class="decision"><span class="eyebrow">ARCHITECTURE DECISION · ADR-001</span><h3>一个后端统筹工作，独立执行环境负责动手。</h3><p>Web 是主要工作台，CLI 和 SDK 复用同一套应用协议。后端在一个进程里组织会话、任务、模型调用、上下文与工具；Shell、浏览器和第三方插件在受约束的执行环境里运行。模型、执行环境和存储都可以替换。</p></div>
<div class="grid three"><article class="card"><b>维护靠边界</b><p>每份状态只有一个写入负责人，每个模块有固定的对外接口。运行内核只协调步骤。</p></article><article class="card"><b>扩展靠契约</b><p>新增模型实现模型接口；新增能力注册工具；新增 Skill 提供说明书；扩展无需把判断散落进循环。</p></article><article class="card"><b>完整靠闭环</b><p>从接收任务、调用工具，到人工接手、取消恢复、交付产物和评测，每个环节都有归属。</p></article></div>
<p class="note"><strong>设计假设：</strong>面向个人或小团队的通用工作 Agent，支持编码、资料研究与文档产出；先提供本地或单实例部署。语言和 UI 框架尚未由你指定，这里建议 TypeScript + Node.js、React + Vite。它们是本方案选型，不是三个开源项目的统一技术栈。</p>
'''))

diagram = (ROOT/'diagrams/agent-architecture.svg').read_text()
diagram = re.sub(r'<\?xml[^>]*\?>','',diagram)
diagram = re.sub(r'<!DOCTYPE[^>]*>','',diagram)
sections.append(section(2,'architecture','一张图看清模块如何合作','实线表示主调用或存储访问，虚线表示上下文读取、状态提交与扩展协作。',f'''
<div class="figure-toolbar"><span>19 个组件 · 22 条连接 · 内部职责与执行边界</span><div><button id="zoomOut" aria-label="缩小架构图">−</button><button id="zoomReset">适应宽度</button><button id="zoomIn" aria-label="放大架构图">＋</button><button id="downloadSvg">下载 SVG</button><button id="downloadDrawio">下载 Draw.io</button></div></div>
<div class="figure-viewport" tabindex="0" aria-label="可横向滚动的架构图"><div id="diagram">{diagram}</div></div>
<div class="figure-caption">阅读顺序：从顶部入口进入中央运行内核，左侧管理状态与内容，右侧管理扩展与编排，下方是真正执行动作的环境。虚线包含结果返回与协作依赖。执行回执返回 Tool System → Runtime，形成下一步；SkillCatalog 由 Context Builder 按需读取。网关接口在后端，Worker 在独立进程或容器；状态、内容和编排默认仍由一个后端托管。可放大滚动查看。</div>
<div class="grid three"><article class="card"><span class="tag">控制</span><h3>决定下一步</h3><p>应用服务接住用户意图，Runtime 驱动“准备资料 → 调模型 → 用工具 → 看结果”的循环。</p></article><article class="card"><span class="tag orange">执行</span><h3>把动作做出来</h3><p>工具系统统一校验和调度；权限模块决定能否做；执行网关把动作交给 Worker 或连接器。</p></article><article class="card"><span class="tag purple">状态</span><h3>记住发生了什么</h3><p>会话保留过程，任务保存目标，内容服务管理记忆和产物；下轮只带需要的资料。</p></article></div>
<p class="note"><strong>部署边界：</strong>应用服务、Runtime、上下文、模型网关、工具调度、权限、状态与扩展管理，默认在一个后端进程中。Worker 是执行边界，MCP/API 是外部服务边界；图里的方框不等于微服务。</p>
'''))

flow = [
('接收任务','Application','用户说：“查一下三个开源项目，写一份架构报告。”应用服务确认用户和工作区、保存输入，创建 Task 与 Run。','先持久化命令，再返回 runId；相同 clientRequestId 不重复创建运行。'),
('准备资料','Context Builder','读取当前分支的历史、任务目标、已确认约束和相关记忆；先放 Skill 简介，需要时再加载正文。','输出 ContextSnapshot：消息、工具目录版本、模型能力、资料引用与预算。'),
('调用模型','Model Gateway','把通用消息转换为具体模型协议。流式文字显示到工作台，完整工具参数组装完毕后再交给工具系统。','保存请求快照与 attemptId；截断或格式不完整的工具调用不能执行。'),
('检查动作','Tool System → Policy','模型建议搜索源码。系统发现工具、校验参数，执行前 Hook 可提出修改；最终参数再次校验，然后判断权限。','决策是 allow / deny / ask；批准绑定到工具、参数摘要、工作区和策略版本。'),
('等待人或执行','Interaction → Execution','需要审批时展示具体动作并持久化等待；已允许的检索交给连接器，读文件和运行命令交给受约束的 Worker。','审批等待不占 Worker；恢复后再验证授权是否仍然适用。'),
('收回结果','Tool System → Runtime','多个独立检索可以并行，结果按 toolCallId 关联。长输出存文件，只把摘要和引用放回模型上下文。','区分成功、失败、未开始、取消与结果未知；同一文件的写入加资源锁。'),
('决定是否继续','Runtime','有结果后重新组装资料，模型可以继续查、修正计划或请求用户补充。新消息在下一步边界加入。','每步检查取消、步数、耗时与费用预算；无新进展时停止重复调用。'),
('交付与验收','Artifact + Application','报告登记为有版本的 Artifact；工作台展示预览和下载。检查所需文件与格式后记录运行完成。','模型说“完成”只是信号，交付验收还要检查产物、验证记录与未解决项。'),
]
flow_html=''.join(f'<button class="step-button{" active" if i==0 else ""}" data-step="{i}" aria-pressed="{"true" if i==0 else "false"}"><span>{i+1:02}</span>{html.escape(x[0])}</button>' for i,x in enumerate(flow))
flow_list=''.join(f'<li><b>{a} · {b}</b><p>{c}</p><small>{d}</small></li>' for a,b,c,d in flow)
sections.append(section(3,'journey','跟着一个任务走一遍','点选步骤，查看每次交接时谁负责、留下什么记录。',f'''
<div class="walkthrough"><div class="step-list">{flow_html}</div><article id="stepDetail" aria-live="polite"><span class="eyebrow">01 / 08 · {flow[0][1]}</span><h3>{flow[0][0]}</h3><p>{flow[0][2]}</p><div class="step-contract">{flow[0][3]}</div></article></div>
<details class="full-flow"><summary>展开完整流程，便于连续阅读与打印</summary><ol>{flow_list}</ol></details>
<p class="note">这里的“思考”指模型调用与可见行动计划。产品记录可见消息、工具动作和执行证据，不依赖模型提供内部思维过程。</p>
'''))

modules = [
('01','应用服务','application/','接待员：把用户请求变成明确的运行命令。','提供 session.create、run.start / steer / cancel / resume、approval.resolve、artifact.list；鉴权、输入幂等、工作区范围与事件订阅。','拥有用例事务与会话写入队列；不组装厂商请求，也不直接启动 Shell。'),
('02','Agent Runtime','kernel/runtime/','项目负责人：持续决定该进入哪一个执行环节。','维护运行状态机、step 循环、终止条件、取消树、输入队列和预算；调用上下文、模型与工具接口。','拥有当前 Run / Step 的状态推进；计划表只是任务数据，不能另起一套循环。'),
('03','Context Builder','kernel/context/','资料员：每次只把相关材料摆到模型面前。','组合系统指令、项目规则、任务状态、选中历史、Skill 与检索结果；按 token 预算裁剪、压缩并生成快照。','只读业务状态，压缩生成新摘要版本；工具调用与结果必须成对保留。'),
('04','Model Gateway','kernel/model/ + adapters/models/','翻译员：让内核用同一种语言和不同模型沟通。','统一 message / toolCall / usage / error 流；用能力表说明图片、工具、结构化输出及上下文限制。','只在适配层保留厂商字段；不支持的能力明确拒绝或显式降级。'),
('05','Tool System','kernel/tools/','工具管理员：知道有哪些工具以及怎样调用。','注册、发现、Schema 校验、Hook 顺序、权限委托、资源锁、有界并发、输出截断与标准结果。','不把模型工具名直接映射为任意函数；只调已经注册且处于当前授权目录的工具。'),
('06','Policy + Interaction','kernel/policy/ + kernel/interaction/','门禁与接线员：判断权限，必要时请人做决定。','结合用户、工作区、插件来源、最终参数和效果范围，返回 allow / deny / ask；提问与审批有不同记录。','授权由服务端保存；前端只提交答案。Hook 或子 Agent 不能扩大既有授权。'),
('07','Execution Gateway','kernel/execution/ + adapters/execution/','工作车间：在给定范围里真正执行动作。','接收 ExecutionRequest，选择本地 Worker、容器或远端连接器；处理超时、进程回收、凭证注入和执行回执。','普通子进程只提供故障隔离；文件、网络与进程权限需要 OS 沙箱或容器实际约束。'),
('08','状态服务','state/','工作记录本：历史、运行进度和任务目标分开存。','Session 管分支与消息历史；Run 管执行状态；Task 管目标、计划和验收；Invocation 管一次工具动作。','通过版本号与事务提交，单 Session 同时只允许一个运行者写主分支。'),
('09','内容服务','content/','资料库与交付柜：管理知识、记忆和最终作品。','Memory 管用户偏好与长期事实；Retrieval 管导入、切块、索引与来源；Artifact 管文件、版本和预览。','搜索索引可重建，源文档与产物是权威内容；记忆必须带来源、范围、时间与删除入口。'),
('10','Extension Host','extensions/','装配员：按清单把需要的能力装起来。','插件清单、依赖排序、Schema 校验、版本锁、作用域注册、Hook 执行与资源回收；SkillCatalog 供上下文按需使用。','首版启动时装配，活动 Run 固定能力版本。可信内置插件可在进程内，第三方代码放进受约束的 Worker。'),
('11','任务编排','orchestration/','调度员：安排什么时候做、哪些部分交给谁。','Workflow 执行固定依赖步骤；Scheduler 管定时和唤醒；Jobs 管后台操作；Subagents 管父子关系、收件箱与汇总。','统一通过应用命令启动 Run，不能绕开权限、预算或持久化。子任务在独立 Session 中运行。'),
('12','存储与观测适配器','adapters/storage/ + observability/','账房与仪表盘：可靠保存数据，解释成本和失败。','SQLite 事务保存结构化状态和事件；文件保存大内容；记录 runId / stepId / toolCallId 链路、时延、费用与错误码。','执行审计与性能 Trace 分开。Trace 可以采样，授权及执行结算记录必须保留。'),
]
cards=''.join(f'<details class="module"><summary><span class="module-number">{n}</span><span><b>{title}</b><small>{path}</small></span><span class="plus">＋</span></summary><div><p class="analogy">{analogy}</p><p>{responsibility}</p><p class="boundary"><b>边界：</b>{boundary}</p></div></details>' for n,title,path,analogy,responsibility,boundary in modules)
sections.append(section(4,'modules','模块职责：出了问题该找谁','按职责分目录，所有模块都有清楚的输入、输出和状态所有者。',f'<div class="section-actions"><button id="expandModules">展开全部职责</button></div><div class="grid two">{cards}</div>'))

state_rows=[
('Session / Branch','state/session','一段可继续的对话；branchId + parentBranchId + forkSeq。','切分支只改变采用哪段历史；不会撤销文件或外部系统的操作。'),
('Task','state/task','目标、计划、约束、验收标准、工作流节点及子任务关系。','一项 Task 可以跨多次 Run；完成任务需要满足验收标准。'),
('Run / Step','kernel/runtime → state/run','Run 是一次持续执行；Step 是一次模型调用及其关联工具批次；重试另有 attemptId。','对外 status 与内部 phase 分开，停止原因单独记录。'),
('Invocation / Approval','kernel/tools / policy → state','toolCallId、最终参数摘要、权限范围、执行阶段与回执。','审批绑定参数摘要与策略版本；结果未知的写操作先核对回执。'),
('Memory / Source','content/memory / retrieval','有来源和作用域的长期事实，以及可重新索引的原始材料。','明确保存或受信规则提炼；检索与展示都按用户、工作区过滤。'),
('Artifact / Revision','content/artifacts','产物类型、blobRef、hash、来源 Run、父版本和验证记录。','大内容存文件；预览只是视图，下载必须对应确切版本。'),
]
sections.append(section(5,'state','状态与恢复：记得住，也接得上','本方案选择 SQLite 作为结构化状态的权威存储；JSONL 用于导出与诊断。',table(['对象','唯一写入负责人','存什么','关键约束'],state_rows)+'''
<div class="grid two"><article class="card"><h3>状态机怎样结束</h3><p><code>queued → running → succeeded / failed / cancelled</code></p><p>运行可进入 <code>waiting_user</code>、<code>waiting_job</code>；进程意外退出后标为 <code>interrupted</code>。恢复是重新校验条件后回到队列。内部 phase 再细分 preparing、model、tools。</p><p>预算耗尽、用户拒绝、模型截断、无进展都有独立 reason。模型结束输出与任务验收通过是两件事。</p></article><article class="card"><h3>事件如何可靠交付</h3><p>关键状态变更与 RunEvent 在同一事务写入；事件包含 <code>schemaVersion、eventId、sessionId、runId、seq、type</code>。每个 Session 的 seq 单调递增。</p><p>UI 按 seq 去重、按游标补读；实时 token 增量可合并且允许丢失，已完成消息和工具结算必须持久化。断线后先同步快照，再补事件。</p></article></div>
<div class="callout"><h3>恢复现场，绝不把“没收到结果”当成“没做过”。</h3><p>调用前提交 <code>intent</code>，派发前提交 <code>dispatching</code>，获得回执后提交 <code>settled</code>。两次提交之间崩溃，执行结果可能未知：有查询或幂等接口就对账；没有则停在待核对状态，请人确认后继续。外部副作用不能靠本地数据库事务获得全局 exactly-once。</p></div>
<p>单实例使用每会话写入队列 + 数据库 revision 防止双写。多进程部署时，执行租约需要带 fencing token：旧 Worker 即使迟到，也不能覆盖新运行的状态。持久事件用于重建状态，重建时不重放外部动作。</p>
'''+refs('P3','C5','D5','D6')))

extrows=[
('Tool','让系统做一件事','输入 Schema + 效果说明 + 执行处理器','搜索资料、读文件、保存产物。所有实际动作经过工具 / 执行治理。'),
('MCP','和外部能力对话的协议','服务连接配置 + 工具 / 资源 / Prompt 映射','MCP 工具接入 ToolRegistry；资源带引用进入上下文；外部 Prompt 经信任处理后使用。'),
('Skill','教模型怎样完成一类任务','摘要、SKILL.md 正文、引用文件与脚本','先发现摘要，按需加载正文；脚本仍作为受治理的工具动作执行。'),
('Hook','在固定时点增补行为','类型化输入 + 限定返回值 + 超时','beforeContext 增补材料；beforeTool 提议修改；afterTool 观测结果。'),
('Plugin','把相关扩展打包并管理生命周期','manifest + activate / dispose + 权限声明','把模型适配器、工具、Skill、Hook 或受控 UI 扩展一起安装与启用。'),
('Subagent','把一个明确子任务交给独立运行者','任务说明 + 上下文引用 + 权限上限 + 结果协议','独立 Session 和预算，回传摘要与产物引用；父任务负责合并和验收。'),
]
sections.append(section(6,'extensions','扩展能力：六个概念，各司其职','插件负责组合；Skill 提供知识；Hook 扩展生命周期；Tool 执行动作。',table(['概念','通俗理解','契约','进入系统的位置'],extrows)+'''
<div class="grid two"><article class="card"><h3>插件生命周期</h3><p><code>发现 → 校验 → 解析依赖 → 注册 → 激活 → 停止接单 → 回收资源</code></p><p>manifest 声明 id、version、apiVersion、requires、capabilities。依赖缺失、循环依赖、重名工具在启动时失败；所有注册返回 dispose 句柄。</p><p>首版采用显式依赖注入和启动装配。运行中锁定插件、工具 Schema 与模型配置的版本快照；升级在运行边界生效。</p></article><article class="card"><h3>Hook 能做多大修改</h3><p>观测 Hook 只接收不可变事件，失败只记录；控制 Hook 可返回 patch / deny / ask，失败按预设策略处理。权限相关失败必须停止执行。</p><p>固定排序：参数初检 → beforeTool → 最终参数校验与冻结 → Policy → 执行。任何参数、资源或权限范围变化，都重新决策。</p><p>脚本 Hook 通过 Execution Gateway；不可信插件无法拿到主进程原始文件系统或凭证对象。</p></article></div>
<p class="note"><strong>工具授权与进程权限需要一起成立：</strong>进程内任意 JavaScript 可以直接访问 Node.js API，单靠一个 Plugin 接口无法建立安全边界。第三方插件使用能力代理访问资源；可接受的可信内置插件纳入代码审查范围。</p>
'''+refs('D3','D7','D8','D9','P4')))

directory = '''myagent/
├── apps/
│   ├── web/                         # React 工作台：对话、任务、审批、产物
│   │   └── src/{pages,features,components}/
│   ├── server/                      # HTTP/SSE 入口，唯一后端装配点
│   │   └── src/{main,bootstrap,routes,streams}/
│   ├── cli/                         # 终端客户端，通过 SDK 调用应用协议
│   └── worker/                      # 独立执行进程，支持受约束的执行后端
├── packages/
│   ├── contracts/                   # 无业务依赖：DTO、事件、Schema、错误码
│   │   └── src/{commands,events,messages,tools,versions}/
│   ├── sdk/                         # 客户端：发命令、订阅事件、断线补读
│   ├── application/                 # 用例编排与事务、授权主体、幂等命令
│   │   └── src/{sessions,runs,tasks,approvals,artifacts,ports}/
│   ├── kernel/                      # 与 UI、HTTP 框架、数据库驱动无关
│   │   └── src/
│   │       ├── runtime/             # loop、状态机、inbox、预算、取消树
│   │       ├── context/             # 指令层级、组装、裁剪、压缩、快照
│   │       ├── model/               # ModelPort、能力协商、统一流与重试规则
│   │       ├── tools/               # ToolRegistry、pipeline、资源锁、结果归并
│   │       ├── policy/              # PolicyPort、效果分类、授权范围、决策
│   │       ├── interaction/         # 提问与审批等待协议
│   │       ├── execution/           # ExecutionPort、执行信封、回执类型
│   │       └── ports/               # StatePort、ContentPort、HookPort、时钟
│   ├── state/                       # 状态领域与仓储接口
│   │   └── src/{session,run,task,invocation,event-log,recovery}/
│   ├── content/                     # 记忆、原始资料与版本化产物
│   │   └── src/{memory,retrieval,artifacts,ports}/
│   ├── extensions/                  # 扩展 SPI 与生命周期管理
│   │   └── src/{manifest,loader,registry,skills,hooks,scopes}/
│   ├── orchestration/               # 长任务与协作，依赖 RunCommandPort
│   │   └── src/{workflow,scheduler,jobs,subagents,mailbox}/
│   ├── adapters/                    # 实现内核 / 应用定义的 Port
│   │   └── src/
│   │       ├── models/{openai,anthropic,deepseek}/
│   │       ├── execution/{local,container,remote}/
│   │       ├── connectors/{mcp,http,browser}/
│   │       ├── storage/{sqlite,filesystem}/
│   │       ├── identity/{local,oidc}/
│   │       ├── credentials/         # 操作系统凭证库或部署 Secret 接口
│   │       └── observability/       # Trace / 日志具体后端
│   ├── observability/               # 观测接口、字段约定、脱敏规则
│   └── testing/                     # FakeModel、FakeTool、FakeClock
├── plugins/
│   ├── builtin/{filesystem,shell,browser,artifact-tools}/
│   ├── research/                    # 示例业务能力包，按需加载
│   └── writing/                     # 示例业务能力包
├── skills/{research,architecture,writing}/SKILL.md
├── workflows/                       # 声明式工作流定义和版本
├── config/
│   ├── defaults.yaml                # 非敏感默认配置
│   ├── profiles/{local,server}.yaml  # 部署组合与执行后端
│   └── plugins.lock.json            # 插件版本与内容摘要
├── tests/
│   ├── unit/                        # 状态机、预算、权限、上下文投影
│   ├── contract/                    # Model / Tool / Execution / Storage 一致性
│   ├── integration/                 # 崩溃恢复、审批恢复、取消、事件补读
│   ├── architecture/                # 禁止循环依赖、越层导入与深路径导入
│   └── e2e/                         # 用户输入到产物交付的整条链路
├── evals/{cases,graders,baselines}/   # 真实任务质量、成本和完成率
├── migrations/                      # 数据库与事件格式的版本迁移
├── docs/{architecture,adr,protocols}/ # 决策原因、扩展协议、模块契约
├── scripts/                         # 构建、检查与发布辅助
├── pnpm-workspace.yaml
└── package.json

# 运行数据在仓库外，例如 ~/.myagent/：
# state.db、blobs/、workspaces/、logs/、exports/；密钥放凭证库。
'''
sections.append(section(7,'directory','项目目录：可以直接照此建立工程','以下是建议的目标目录，不是本次已实现的应用代码。目录按职责分，避免按文件数量拆包。',f'''
<div class="tree-toolbar"><span>TypeScript monorepo · pnpm workspace</span><button id="copyTree">复制目录结构</button></div><pre class="tree" id="directoryTree">{html.escape(directory)}</pre>
<div class="grid two"><article class="card"><h3>允许的依赖方向</h3><p><code>web / cli → sdk → contracts</code></p><p><code>server/bootstrap → application + kernel + adapters + extensions</code></p><p><code>application → kernel + state + content</code></p><p><code>kernel → contracts + 自身 ports</code></p><p><code>adapters → 对应的 ports / contracts</code></p><p>orchestration 只调用 RunCommandPort，bootstrap 注入 application 实现，避免应用层和编排层互相 import。</p></article><article class="card"><h3>把边界变成检查规则</h3><p>kernel 不导入 React、HTTP 框架、数据库驱动或厂商 SDK。模块通过公开 index 导出访问，不跨模块读取内部文件。</p><p>contracts 保持纯数据定义；adapters 可以依赖内核接口，内核不能反向依赖 adapters。架构检查在 CI 中阻止循环依赖。</p><p>初期只把 kernel、application、contracts、adapters 等做成工作区包；kernel 内的 runtime、tools 等保持子目录即可。</p></article></div>
'''))

interfaces=[
('RunCommandPort','start / steer / followUp / cancel / resume','返回 runId 和可补读事件游标；命令带 clientRequestId / expectedRevision。'),
('ContextBuilder','build(stepInput) → ContextSnapshot','包含 messages、tools、sourceRefs、budget、configDigest；可重建确切请求素材。'),
('ModelPort','describeCapabilities / stream(request, signal)','AsyncIterable&lt;ModelEvent&gt;；统一 text、toolCall、usage、error，保留 attempt 归属。'),
('ToolRegistry + ToolRunner','describe / resolve / execute(call, context)','定义含 Schema、effects、resourceKeys、timeout、幂等能力、结果类型和版本。'),
('PolicyPort','evaluate(finalIntent) → allow | deny | ask','intent 含主体、参数摘要、资源、effect、工作区及策略版本；allow 携带受限执行授权。'),
('ExecutionPort','dispatch(request) / cancel / inspectReceipt','执行信封含 invocationId、能力范围、deadline、credentialRef；inspectReceipt 可明确不支持。'),
('StatePort','commit(expectedRevision, changes, events)','事务提交状态与事件；快照能按 schemaVersion 迁移；回放不执行副作用。'),
('ContentPort','memory.search / source.read / artifact.commit','返回结构化引用和 revision；大内容通过 blobRef 访问，遵守主体与工作区权限。'),
('Plugin SPI','activate(context) → dispose','只开放声明的注册与能力代理；注册次序、生命周期、超时、权限范围有明确约定。'),
]
sections.append(section(8,'contracts','把扩展口定稳，后面才好加功能','这些是概念契约。后续实现时用 TypeScript 类型 + 运行时 Schema 共同约束。',table(['接口','核心操作','必须写进协议的语义'],interfaces)+'''
<div class="grid three"><article class="card"><h3>换一个模型</h3><p>新增 adapters/models 下的实现，声明能力与错误映射；通过契约测试后注册。会话格式、Runtime 与工作台保持共同协议。</p></article><article class="card"><h3>加一个业务工具</h3><p>在 plugins 下注册 Schema、效果和 handler；需要联网或凭证时申请对应能力。工作台先用通用工具卡渲染。</p></article><article class="card"><h3>换执行环境</h3><p>新增 ExecutionPort 实现，保证文件访问和进程使用同一 workspaceRef。远端文件系统不能搭配本地 Shell 假装同一个环境。</p></article></div>
<p>配置优先级固定为：内置默认 → 部署 profile → 用户 → 项目 → 本次 Run 的允许覆盖项。安全策略按权限上限求交集，项目配置不能扩大服务端授权。Run 保存解析后的配置摘要，密钥仅保存引用。</p>
'''))

sections.append(section(9,'complete','功能完整，还要设计好这些横向能力','功能清单对应到负责模块与可验证的行为，避免出现只有入口、没有执行闭环的能力。',table(['能力','模块','验收方式'],[
('流式对话 / 附件 / 多模型','SDK、Context、Model、Content','上传文件能形成带范围的引用；模型能力不足时明确提示；断流保留已完成项。'),
('长上下文 / 记忆 / 知识检索','Context、Content','上下文不过预算；压缩保留目标与调用配对；返回引用能定位源片段；删除记忆后不再检出。'),
('读写文件 / Shell / 浏览器 / MCP','Tool、Policy、Execution','同一调用可定位权限决策、执行环境和结果；文件写入检查版本，HTML 产物在隔离预览中打开。'),
('计划 / Workflow / 后台与定时任务','Task、Orchestration','模型计划可调整；固定流程节点有独立输入输出、重试与检查点；定时触发按 scheduleId + scheduledAt 去重。'),
('人工提问 / 审批 / 中途改要求','Interaction、Runtime','等待持久化；用户回答能恢复；steer 下一步生效，followUp 排到当前 Run 后；cancel 停止继续派发。'),
('多 Agent','Orchestration、Application','子任务有 parentRunId、独立 Session、并发/深度/费用上限；父级取消向下传播；合并冲突可见。'),
('版本化产物 / 会话分支','Artifact、Session','产物有 revision、预览和下载；分支明确提示工作区状态，必要时创建隔离副本或 worktree。'),
('用户与工作区 / 凭证','Application、Policy、Identity adapter','HTTP 命令和事件流均校验身份与资源范围；密钥按工具所需注入，不进入模型上下文。'),
('故障恢复 / 观测 / 评测','State、Execution、Observability','强制退出后区分未开始与结果未知；用户能看到卡在哪一步；同一评测集比较成功率、质量与成本。'),
])+'''
<div class="grid two"><article class="card"><h3>上下文是按预算组织的资料包</h3><p>先保留系统约束、当前目标与最新交互，再分配历史、Skill、检索和工具输出额度，并预留输出 token。采用“近期原文 + 旧历史摘要 + 可追溯引用”。</p><p>记录选中素材的版本、来源及信任等级。网页、代码仓库说明、MCP 返回值都作为资料，不能据此自动授予权限。系统与项目指令的来源保持可见。</p></article><article class="card"><h3>多 Agent 是有边界的委派</h3><p>父任务只发送子任务需要的约束与资料引用。子 Agent 的权限取父级权限与角色权限的交集，预算从父级原子预留，完成后结算。</p><p>默认串行推进有依赖的工作；独立检索允许并行。写同一资源要加锁或在隔离工作区完成，父任务通过 Artifact 引用汇总，不把所有子对话塞回主上下文。</p></article></div>
<div class="callout"><h3>技术选型与扩容条件</h3><p>初始建议：Node.js 的受支持 LTS 版本 + TypeScript、React + Vite、pnpm、JSON Schema、SQLite + 文件存储、HTTP 命令 + SSE 事件流、OpenTelemetry 接口。版本在开工时锁定。SQLite 适合单实例；出现多实例写入需求时，把仓储适配器迁到 PostgreSQL，并引入租约与事件 outbox。</p><p>模型 I/O 一般无需为性能引入多语言内核；先测量队列等待、上下文大小、工具时延和 token 成本。需要独立扩容时优先拆执行 Worker；大型后台流程需要跨机耐久调度时再接外部工作流引擎。</p></div>
'''))

from report_details import build_details
sections.extend(build_details(section, table, refs))

source_rows=[
('Pi','agent-loop / ai 类型 / session-manager','模型边界清楚，循环支持用户插入消息；树状会话能生成分支上下文。','采用小内核与消息转换层。权限与沙箱作为本方案必备能力补齐。',refs('P1','P3','P5')),
('Pi','工具参数处理与单元测试','长度截断阻止工具执行；beforeToolCall 修改后的参数可直接执行。','保留截断保护；在本方案中增加 Hook 后最终校验和请求冻结。',refs('P2','P4')),
('Codex','session/turn + ToolRouter','每步统一捕获上下文；模型看到的工具和实际路由保持对应。','建立 StepContext 与能力版本快照，避免展示与执行不一致。',refs('C1','C2')),
('Codex','ToolOrchestrator','审批、沙箱选择、执行尝试集中处理。','采用统一执行管线；仅在既定授权内选择执行策略，不因失败自动扩大权限。',refs('C3')),
('Codex','app-server + rollout','前后端采用明确事件协议；有背压；记录会话与分支血缘。','借鉴协议和事件边界。自建 HTTP/SSE 产品协议，避免把底层传输直接当产品鉴权层。',refs('C4','C5')),
('DeepSeek Harness','agent-loop + tool-calls','步骤有明确结束原因；工具有有界并发、独占屏障和顺序结算。','将取消、并发与结果归并归到内核，控制 Hook 与执行结果分离。',refs('D1','D2','D4')),
('DeepSeek Harness','session + repair','从事件派生模型历史，恢复时区分没开始和结果未知。','选择事务事件日志与请求快照，加入对账路径；本方案采用 SQLite 权威存储。',refs('D5','D6')),
('DeepSeek Harness','Cordis + Skill + guard','服务有生命周期；Skill 目录与提供者分离；guard 可单向收紧。','采用作用域注册与 dispose 契约，首版静态装配稳定内核；后续按需增加动态卸载。',refs('D3','D7','D8','D10')),
]
snap_html=''.join(f'<article class="snapshot"><b>{"DeepSeek Harness" if k=="deepseek-harness" else "Codex" if k=="codex" else "Pi"}</b><a href="https://github.com/{v["repo"]}/commit/{v["sha"]}" target="_blank" rel="noreferrer"><code>{v["sha"][:12]} ↗</code></a></article>' for k,v in snapshots.items())
source_details=''.join(f'<li id="src-{i}"><b>{i} · {x["title"]}</b><p>{x["finding"]}</p><a href="{x["url"]}" target="_blank" rel="noreferrer"><code>{x["repository"]}/{x["path"]} · L{x["start"]}–L{x["end"]}</code> ↗</a></li>' for i,x in source_map.items())
sections.append(section(12,'sources','源码依据与设计取舍','研究日期：2026-09-07。引用固定到本次获取的提交，不随默认分支更新。',f'''
<div class="grid three">{snap_html}</div>
{table(['参考项目','实际阅读位置','源码事实','本方案取舍','证据'],source_rows)}
<p class="note"><strong>证据范围：</strong>本次对三个仓库做了静态源码阅读，覆盖循环、模型边界、工具路由、执行治理、会话、插件与代表性测试；没有启动三个项目、执行其测试套件或评估实际性能。表中的“本方案取舍”、目录、状态机与选型均为设计建议，不是对上游现有实现的描述。DeepSeek Harness 在所读 README 中仍标为 developer preview。</p>
<details class="source-details"><summary>展开 20 处源码定位</summary><ol>{source_details}</ol></details>
<p class="small">补充文档：<a href="https://learn.chatgpt.com/docs/app-server" target="_blank" rel="noreferrer">OpenAI 官方 App Server 文档 ↗</a>。本方案仅研究开源 Codex 的边界，不把闭源桌面产品的所有能力视作仓库实现。</p>
'''))

checks=[
('循环正确性','FakeModel 返回“工具调用 → 工具结果 → 最终消息”，验证步骤与消息配对；截断参数不派发。'),
('状态与恢复','在 intent、dispatching、settled 三处强制中断；未知写操作不能自动重试；事件游标可补读且不重复展示。'),
('权限边界','Hook 改参数、项目配置扩权、子任务越权、审批过期与资源 revision 改变，都必须重新决策或拒绝。'),
('并发与取消','独立读取能并行；同资源写入串行；取消会停止新调用并收拢运行中的调用，不伪造成功。'),
('上下文与扩展','压缩后保留目标和引用；插件缺依赖时报错；替换模型适配器无需改 Runtime；清理后没有遗留监听器。'),
('产品验收','从 UI 发起研究任务，审批后继续，产出可下载文档；断线再连能恢复；展示实际 token、费用估算与结果验证。'),
]
sections.append(section(13,'acceptance','后续开发时，怎样证明架构落地了','本次只交付设计。以下是未来实现的验收契约，可直接转成测试与开发任务。',table(['验收面','可执行的检查'],checks)+'''
<div class="decision closing"><span class="eyebrow">IMPLEMENTATION ORDER</span><h3>按纵向任务闭环实现，每一轮都能交付。</h3><p>先打通应用协议、事件日志与无工具对话；再接一个真实工具和权限执行链；接着完善上下文、Skill、产物与恢复；最后在同一内核上增加 Workflow、后台调度和子 Agent。整个过程中保持本页的模块边界与契约。</p><p>每次接入新模型或工具先跑契约测试；升级内核后重跑固定任务评测。成功率同时看产物质量、可验证事实、成本和耗时，不能只统计“模型正常结束”。</p></div>
'''))

CSS = r'''
:root{--bg:#f5f4ef;--paper:#fffefb;--ink:#1e302f;--muted:#566967;--line:#dce2db;--green:#14685d;--mint:#e6f1e9;--orange:#a45528;--purple:#695777;--shadow:0 8px 30px #24433507}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:30px}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.85}a{color:var(--green);text-decoration:none}a:hover{text-decoration:underline}button{font:inherit;font-size:13px;color:var(--ink);background:var(--paper);border:1px solid var(--line);padding:7px 13px;border-radius:7px;cursor:pointer}button:hover{border-color:var(--green);background:var(--mint)}:focus-visible{outline:3px solid #bf782c;outline-offset:3px}.layout{max-width:1560px;margin:auto;display:grid;grid-template-columns:230px minmax(0,1fr);gap:48px;padding:0 42px 0 30px}.sidebar{position:sticky;top:0;height:100vh;overflow:auto;padding:40px 0 24px;border-right:1px solid var(--line)}.brand{display:flex;gap:12px;align-items:center;font-size:19px;font-weight:750;letter-spacing:.2px}.brand-icon{display:grid;place-items:center;width:35px;height:35px;background:var(--green);color:#fff;border-radius:10px;font-size:17px}.sidebar .edition{font-size:11px;color:var(--muted);letter-spacing:1.3px;margin:17px 0 35px}nav{display:grid;gap:7px;padding-right:22px}nav a{display:flex;gap:13px;font-size:13px;padding:8px 11px;color:var(--muted);border-radius:7px}nav a span{font-size:10px;letter-spacing:1px;color:#6e827e}nav a:hover,nav a.active{background:#e6ece5;color:var(--green);text-decoration:none}.side-foot{font-size:11px;color:var(--muted);margin-top:35px;padding:20px 20px 0 11px;border-top:1px solid var(--line)}main{min-width:0;padding-top:42px}.topbar{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--muted);letter-spacing:1.5px}.status-dot{display:inline-block;width:6px;height:6px;background:var(--green);border-radius:50%;margin-right:8px}.hero{padding:65px 0 48px;border-bottom:1px solid var(--line)}.eyebrow{font-size:11px;font-weight:650;letter-spacing:1.8px;color:var(--green)}h1{font-size:clamp(36px,4.4vw,63px);line-height:1.23;letter-spacing:-2px;margin:18px 0 25px;max-width:900px}h1 em{font-style:normal;color:var(--green)}.hero .intro{font-size:18px;color:var(--muted);max-width:750px;line-height:1.85}.hero-meta{display:flex;flex-wrap:wrap;gap:9px;margin-top:30px}.hero-meta span{font-size:12px;border:1px solid var(--line);padding:5px 12px;border-radius:30px}.hero-bottom{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:30px}.hero-bottom a{background:var(--green);color:white;padding:10px 19px;border-radius:8px;font-size:13px}.hero-bottom small{font-size:12px;color:var(--muted)}section{padding:47px 0;border-bottom:1px solid var(--line)}.section-head{display:flex;gap:18px;align-items:flex-start;margin-bottom:25px}.num{font:12px ui-monospace,SFMono-Regular,monospace;padding-top:10px;color:var(--green)}h2{font-size:27px;line-height:1.5;letter-spacing:-.5px;margin:0 0 7px}.section-head p{color:var(--muted);margin:0}h3{font-size:18px;line-height:1.6;margin:10px 0}p{margin:10px 0}.decision{background:var(--mint);padding:28px 32px;border:1px solid #c6ddcf;border-radius:13px;margin:20px 0}.decision h3{font-size:24px;margin:12px 0}.grid{display:grid;gap:16px;margin:20px 0}.three{grid-template-columns:repeat(3,minmax(0,1fr))}.two{grid-template-columns:repeat(2,minmax(0,1fr))}.card{border:1px solid var(--line);border-radius:11px;padding:22px;background:var(--paper);box-shadow:var(--shadow);min-width:0}.card p{font-size:14px;color:var(--muted)}.card b{font-size:16px}.note{font-size:13px;color:var(--muted);border-left:3px solid #adc8bc;padding:10px 18px;margin:22px 0}.tag{display:inline-block;background:var(--mint);color:var(--green);font-size:11px;padding:1px 9px;border-radius:20px}.tag.orange{background:#f8eadc;color:var(--orange)}.tag.purple{background:#ede7f2;color:var(--purple)}.figure-toolbar,.tree-toolbar{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:12px 17px;background:#e9eee7;border:1px solid var(--line);border-radius:10px 10px 0 0;font-size:12px}.figure-toolbar div{display:flex;gap:5px;flex-wrap:wrap}.figure-viewport{overflow:auto;background:#fff;border:1px solid var(--line);border-top:0;padding:22px;max-height:1100px}#diagram{width:100%;min-width:0px;transition:width .2s}#diagram svg{display:block;width:100%;height:auto}.figure-caption{font-size:12px;color:var(--muted);padding:14px 5px}.walkthrough{display:grid;grid-template-columns:205px 1fr;border:1px solid var(--line);background:var(--paper);border-radius:12px;overflow:hidden}.step-list{display:grid;background:#eef1ea;padding:12px;gap:3px}.step-button{display:flex;gap:13px;text-align:left;border:0;background:transparent;border-radius:7px;font-size:13px;padding:10px}.step-button span{font-family:ui-monospace,monospace;color:var(--muted);font-size:11px}.step-button.active{background:var(--green);color:white}.step-button.active span{color:#d7e8de}#stepDetail{padding:37px;display:flex;flex-direction:column;justify-content:center}#stepDetail h3{font-size:29px;margin:15px 0}#stepDetail p{font-size:17px;color:var(--muted)}.step-contract{margin-top:18px;padding:17px;background:#eef3ec;border-radius:8px;font-size:13px}.full-flow{margin-top:16px}.full-flow ol{padding-left:25px}.full-flow small{color:var(--muted)}summary{cursor:pointer}details summary{font-size:14px}.section-actions{display:flex;justify-content:flex-end}.module{border:1px solid var(--line);border-radius:10px;background:var(--paper);align-self:start;overflow:hidden}.module summary{display:flex;align-items:center;gap:14px;padding:20px;list-style:none}.module summary::-webkit-details-marker{display:none}.module-number{font-family:ui-monospace,monospace;font-size:11px;color:var(--green)}.module summary b{font-size:15px}.module summary small{display:block;font-size:11px;color:var(--muted);overflow-wrap:anywhere}.module .plus{margin-left:auto;color:var(--green)}.module[open] .plus{transform:rotate(45deg)}.module>div{padding:0 22px 20px;font-size:14px}.module .analogy{color:var(--green)}.boundary{font-size:13px;color:var(--muted);border-top:1px solid var(--line);padding-top:12px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--paper);margin:20px 0}table{width:100%;border-collapse:collapse;font-size:13px;min-width:650px}th{text-align:left;background:#eaf0e8;color:#36554d;font-weight:650;white-space:nowrap}th,td{padding:15px 16px;border-bottom:1px solid var(--line);vertical-align:top}td:first-child{font-weight:650;color:var(--ink);min-width:120px}td{color:var(--muted)}tr:last-child td{border-bottom:0}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.87em;overflow-wrap:anywhere;background:#eaf0e980;padding:2px 4px;border-radius:3px}.callout{background:#f7eddf;border:1px solid #e7d4b8;border-left:4px solid #a56932;border-radius:9px;padding:20px 25px;margin:24px 0}.callout p{font-size:14px;color:#655a48}.tree{margin:0;background:#172d2a;color:#d8e6da;border-radius:0 0 11px 11px;padding:25px;overflow:auto;font:12px/1.95 ui-monospace,SFMono-Regular,Menlo,"PingFang SC",monospace;tab-size:2}.ref{display:inline-block;white-space:nowrap;font-size:10px;line-height:1.6;padding:2px 7px;border:1px solid #c6d7cd;border-radius:4px;background:#edf4ef;margin:3px 1px}.snapshot{border:1px solid var(--line);padding:15px 18px;border-radius:9px;display:flex;justify-content:space-between;align-items:center;font-size:14px}.snapshot code{font-size:11px}.source-details{padding:16px 20px;background:var(--paper);border:1px solid var(--line);border-radius:10px}.source-details ol{padding-left:20px}.source-details li{padding:12px 0;border-bottom:1px solid var(--line);font-size:13px}.source-details p{margin:4px 0}.source-details code{font-size:11px;word-break:break-all}.small{font-size:12px;color:var(--muted)}footer{padding:30px 0 50px;font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:20px}.print-only{display:none}#toast{position:fixed;bottom:25px;left:50%;transform:translateX(-50%);background:var(--green);color:white;padding:10px 22px;border-radius:30px;font-size:13px;box-shadow:0 5px 20px #0002;z-index:10}#toast:empty{display:none}
@media(min-width:1450px){body{font-size:16px}.layout{gap:60px}}@media(max-width:1100px){.layout{grid-template-columns:180px minmax(0,1fr);gap:28px;padding:0 25px}.sidebar{padding-top:30px}.three{grid-template-columns:1fr}.snapshot{max-width:none}.hero{padding-top:42px}.figure-toolbar{align-items:flex-start;flex-direction:column}nav{padding-right:12px}nav a{padding:6px;font-size:12px}}@media(max-width:760px){.layout{display:block;padding:0 18px}.sidebar{height:auto;position:relative;border-right:0;padding:20px 0 15px}.sidebar .edition,.side-foot{display:none}nav{display:flex;overflow:auto;white-space:nowrap;gap:6px;margin-top:17px;padding:0 0 6px}nav a{padding:6px 9px}nav a span{display:none}main{padding-top:8px}.hero{padding:32px 0}h1{font-size:37px;letter-spacing:-1px}.hero .intro{font-size:16px}.two,.three{grid-template-columns:1fr}.hero-bottom{align-items:flex-start;flex-direction:column}h2{font-size:23px}section{padding:32px 0}.section-head{gap:12px}.decision{padding:22px}.decision h3{font-size:21px}.walkthrough{grid-template-columns:1fr}.step-list{display:flex;overflow:auto}.step-button{min-width:132px;white-space:nowrap}#stepDetail{padding:24px;min-height:310px}#stepDetail h3{font-size:25px}#stepDetail p{font-size:16px}.figure-viewport{padding:13px}.tree{padding:18px;font-size:11px}.tree-toolbar{align-items:flex-start;flex-direction:column}footer{flex-direction:column}.topbar{letter-spacing:.4px}.figure-toolbar button{padding:6px 9px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}@media print{body{background:white;font-size:11px}.layout{display:block;padding:0}.sidebar,.topbar button,.hero-bottom a,.section-actions,.figure-toolbar button,.tree-toolbar button,.walkthrough,.full-flow summary,#toast{display:none!important}main{padding:0}.hero{padding:0 0 18px}h1{font-size:36px}.hero .intro{font-size:14px}section{padding:22px 0;break-inside:auto}.section-head{break-after:avoid}h2{font-size:21px}.card,.module,.callout,.decision,tr{break-inside:avoid}.grid.three{grid-template-columns:repeat(3,1fr)}.figure-viewport{overflow:visible;max-height:none;padding:8px}#diagram{width:100%!important;min-width:0}.tree{white-space:pre-wrap;overflow-wrap:anywhere;font-size:8px;color:#152a22;background:#f5f7f1}table{min-width:0;font-size:10px}th,td{padding:8px}.table-wrap{overflow:visible}.full-flow{display:block}.source-details{font-size:10px}.hero-meta{margin:10px 0}.hero-bottom{margin:10px 0}.decision h3{font-size:20px}.note,.card p{font-size:11px}a{color:#14685d}footer{padding:15px 0}.print-only{display:block}@page{size:A4;margin:14mm}}
'''
nav = [("decision","总体决策"),("architecture","架构总图"),("journey","任务如何运行"),("modules","模块职责"),("state","状态与恢复"),("extensions","扩展机制"),("directory","项目目录"),("contracts","接口与依赖"),("complete","完整能力"),("technology","技术选型"),("deployment","部署与协议"),("sources","源码依据"),("acceptance","开发验收")]
nav_html=''.join(f'<a href="#{id}"><span>{i:02}</span>{title}</a>' for i,(id,title) in enumerate(nav,1))
JS = r'''
const drawio=DRAWIO_DATA; document.querySelector('#downloadDrawio').onclick=()=>{const url=URL.createObjectURL(new Blob([drawio],{type:'application/xml'}));const a=document.createElement('a');a.href=url;a.download='agent-architecture.drawio';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
const steps=FLOW_DATA;const detail=document.querySelector('#stepDetail');
document.querySelectorAll('[data-step]').forEach(btn=>btn.addEventListener('click',()=>{const i=Number(btn.dataset.step);document.querySelectorAll('[data-step]').forEach(b=>{b.classList.toggle('active',b===btn);b.setAttribute('aria-pressed',String(b===btn))});const s=steps[i];detail.innerHTML=`<span class="eyebrow">${String(i+1).padStart(2,'0')} / 08 · ${s[1]}</span><h3>${s[0]}</h3><p>${s[2]}</p><div class="step-contract">${s[3]}</div>`}));
let zoom=100;const diagram=document.querySelector('#diagram');function applyZoom(){diagram.style.width=zoom+'%'}document.querySelector('#zoomIn').onclick=()=>{zoom=Math.min(450,zoom+25);applyZoom()};document.querySelector('#zoomOut').onclick=()=>{zoom=Math.max(75,zoom-25);applyZoom()};document.querySelector('#zoomReset').onclick=()=>{zoom=100;applyZoom()};
function toast(text){document.querySelector('#toast').textContent=text;setTimeout(()=>document.querySelector('#toast').textContent='',2400)}
document.querySelector('#copyTree').onclick=async()=>{const text=document.querySelector('#directoryTree').textContent;try{await navigator.clipboard.writeText(text);toast('目录结构已复制')}catch{const r=document.createRange();r.selectNodeContents(document.querySelector('#directoryTree'));getSelection().removeAllRanges();getSelection().addRange(r);toast('已选中目录，可按 Ctrl/Cmd + C 复制')}};
document.querySelector('#downloadSvg').onclick=()=>{const svg=diagram.querySelector('svg');const blob=new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='agent-architecture.svg';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000)};
document.querySelector('#expandModules').onclick=function(){const all=[...document.querySelectorAll('.module')];const expand=all.some(x=>!x.open);all.forEach(x=>x.open=expand);this.textContent=expand?'收起全部职责':'展开全部职责'};
let printDetails=[];window.addEventListener('beforeprint',()=>{printDetails=[...document.querySelectorAll('details')].map(x=>[x,x.open]);printDetails.forEach(([x])=>x.open=true)});window.addEventListener('afterprint',()=>printDetails.forEach(([x,open])=>x.open=open));document.querySelector('#printButton').onclick=()=>window.print();
const navLinks=[...document.querySelectorAll('nav a')];const io=new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting){navLinks.forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#'+e.target.id))}})},{rootMargin:'-8% 0px -70% 0px'});document.querySelectorAll('main section').forEach(s=>io.observe(s));
'''.replace('FLOW_DATA',json.dumps(flow,ensure_ascii=False)).replace('DRAWIO_DATA',json.dumps((ROOT/'diagrams/agent-architecture.drawio').read_text(),ensure_ascii=False))
page=f'''<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>MyAgent · 从零构建完整 Agent 的技术架构</title><style>{CSS}</style></head><body><div class="layout"><aside class="sidebar"><div class="brand"><span class="brand-icon">m</span> MyAgent</div><div class="edition">ARCHITECTURE NOTE / 001</div><nav aria-label="文档目录">{nav_html}</nav><div class="side-foot">设计负责人 · 白鑫磊<br>源码研究 · 2026.09.07<br><br>架构图 / 目录结构 / 通俗讲解<br>单文件 HTML，可离线阅读。</div></aside><main><div class="topbar"><span><i class="status-dot"></i>TECHNICAL ARCHITECTURE</span><button id="printButton">打印 / 保存 PDF</button></div><header class="hero"><span class="eyebrow">BUILD YOUR OWN AGENT</span><h1>从零构建完整 Agent，<br><em>先设计好系统的骨架。</em></h1><p class="intro">以 Pi、Codex 和 DeepSeek Harness 的源码为依据，设计一套能持续执行任务、管理上下文、使用工具、接受人工介入并交付成果的 Agent 架构。</p><div class="hero-meta"><span>模块化单体</span><span>稳定运行内核</span><span>可替换适配器</span><span>受控扩展</span><span>持久状态与恢复</span></div><div class="hero-bottom"><a href="#architecture">从架构总图开始 ↓</a><small>架构设计 v1.1 · 3 个源码快照 · 20 处定位证据</small></div></header>{''.join(sections)}<footer><span>MyAgent / Architecture Note 001<br>面向实现的设计文档 · 2026-09-07</span><span>交付范围：架构图、目标目录、模块说明、接口与验收设计。<br>HTML 内嵌样式、脚本和 SVG；不依赖在线字体或 CDN。</span></footer></main></div><div id="toast" role="status" aria-live="polite"></div><script>{JS}</script></body></html>'''
(ROOT/'agent-architecture.html').write_text(page)
print(f'HTML: {ROOT / "agent-architecture.html"} ({len(page):,} characters)')
print(f'Validated {len(sources)} source anchors against local snapshots.')
