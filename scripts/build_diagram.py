# 原始完整 Agent 架构图生成器：从节点与显式路径生成 SVG、Draw.io 和布局清单。
# 输出是长期设计基线，不等同于当前已实现模块；重建会覆盖对应历史图表。
from pathlib import Path
from html import escape
import json

ROOT = Path(__file__).resolve().parents[1]
W, H = 1540, 1500
nodes = []
# 收集节点的职责、配色和绝对坐标，供 SVG 与 Draw.io 使用同一布局。
def box(id, x, y, w, h, title, lines, tone='green'):
    nodes.append(dict(id=id,x=x,y=y,w=w,h=h,title=title,lines=lines,tone=tone))

box('ui',440,80,660,100,'01  产品入口 · Web / CLI / SDK',['对话与任务列表 · 运行进度 · 人工交互 · 产物预览与下载'])
box('app',440,235,660,110,'02  Application · 应用服务',['身份与工作区 / 命令幂等 / 会话写入队列','start · steer · followUp · cancel · resume · 事件订阅'])
box('runtime',420,430,710,115,'03  Agent Runtime · 唯一运行循环',['Run / Step 状态机 · Inbox · 预算与停止条件 · 取消树','每步冻结配置、工具目录与上下文版本；完成后检查验收'])
box('context',420,605,330,125,'04  Context Builder',['指令层级 / 历史分支 / Skill','检索与记忆 / token 预算','压缩摘要 + 来源引用 + 快照'])
box('model',800,605,330,125,'05  Model Gateway',['能力表 / 模型路由 / 厂商适配','统一消息、工具调用与流事件','超时 / 重试 / 用量与成本'])
box('tools',420,810,330,135,'06  Tool System',['Registry / Schema / Hook 管线','最终参数冻结 / 资源锁','有界并发 / 结果归并与截断'],'orange')
box('policy',800,810,330,135,'07  Policy + Interaction',['主体、资源、效果与授权范围','allow / deny / ask；等待落库','审批绑定参数摘要；恢复再校验'],'orange')
box('execution',420,1100,710,90,'08  Execution Gateway · 执行网关',['能力授权 / workspaceRef / deadline / 凭证引用 / dispatch · cancel · receipt'],'orange')
box('worker',420,1260,330,115,'执行 Worker / 容器',['文件读写 · Shell · Playwright','进程回收 / 文件与网络隔离','主进程与执行环境分离'],'orange')
box('connectors',800,1260,330,115,'外部连接器 / MCP',['MCP stdio 或 Streamable HTTP','HTTP API · 云端工具','返回结构化结果与外部回执'],'orange')
box('session',35,430,300,120,'Session / Run / Invocation',['历史分支 / 运行检查点','调用意图 / 参数摘要 / 回执','每个 Session 单写者'],'purple')
box('task',35,595,300,115,'Task / Plan',['目标 / 约束 / 验收标准','计划版本 / 子任务关联','一项 Task 可以跨多次 Run'],'purple')
box('content',35,770,300,145,'Content Services',['Memory：长期事实与偏好','Retrieval：导入、切块、来源','Artifact：文件、版本与验证','资料包通过 ContentPort 读取'],'purple')
box('store',35,1070,300,145,'Storage Adapters',['SQLite：状态 + 持久事件事务','文件：原始材料 / 产物 / 大输出','FTS5：可重建全文索引','JSONL：导出与诊断'],'purple')
box('orchestration',1205,235,300,140,'Orchestration',['Workflow / Scheduler / Jobs','Subagents / Mailbox','统一调用 RunCommandPort','子任务独立 Session 与预算'],'purple')
box('extensions',1205,430,300,145,'Extension Host',['manifest / API 版本 / 依赖排序','activate / dispose / 注册作用域','注册模型、工具、Skill 与 Hook','活动 Run 固定能力版本'],'purple')
box('skills',1205,635,300,110,'Skill Catalog + Hooks',['Skill：摘要发现、按需读正文','Hook：固定时点、固定返回值','脚本动作进入执行治理'],'purple')
box('credentials',1205,810,300,135,'Credentials + Identity',['本地身份 / 远端 OIDC','操作系统凭证库 / Secret','按调用范围注入凭证','原始密钥不进入上下文'],'purple')
box('observe',1205,1100,300,165,'Observability + Evals',['runId → stepId → toolCallId','结构化日志 / Trace / 指标','授权与执行审计独立持久化','任务质量 / 成本 / 时间基线','订阅脱敏事件，覆盖全部模块'],'purple')

# Explicit control paths; dotted paths are state or extension dependencies.
edges = [
('ui','app',[(770,180),(770,235)],'命令 ↓ / SSE 事件 ↑',(790,213),False),
('orchestration','app',[(1205,290),(1100,290)],'',None,False),
('app','runtime',[(770,345),(770,430)],'启动 / 恢复 Run',(790,391),False),
('runtime','context',[(585,545),(585,605)],'准备资料',(600,580),False),
('context','model',[(750,665),(800,665)],'',None,False),
('model','runtime',[(1130,665),(1150,665),(1150,487),(1130,487)],'',None,True),
('runtime','tools',[(765,545),(765,775),(585,775),(585,810)],'工具请求',(777,759),False),
('tools','policy',[(750,877),(800,877)],'',None,False),
('policy','execution',[(965,945),(965,1030),(965,1100)],'携带执行授权',(980,1020),False),
('execution','worker',[(585,1190),(585,1260)],'受限执行',(600,1230),False),
('execution','connectors',[(965,1190),(965,1260)],'协议调用',(980,1230),False),
('execution','tools',[(420,1145),(395,1145),(395,907),(420,907)],'',None,True),
('tools','runtime',[(420,845),(405,845),(405,507),(420,507)],'',None,True),
('runtime','session',[(420,470),(335,470)],'提交',(344,456),True),
('context','task',[(420,650),(375,650),(375,650),(335,650)],'',None,True),
('context','content',[(420,700),(360,700),(360,830),(335,830)],'',None,True),
('session','store',[(80,550),(20,550),(20,1120),(35,1120)],'',None,True),
('task','store',[(80,710),(10,710),(10,1170),(35,1170)],'',None,True),
('content','store',[(185,915),(185,1070)],'版本内容 / 索引',(196,999),False),
('extensions','runtime',[(1205,495),(1180,495),(1180,450),(1130,450)],'',None,True),
('extensions','skills',[(1355,575),(1355,635)],'提供目录与扩展点',(1370,610),True),
('credentials','execution',[(1355,945),(1355,1020),(1100,1020),(1100,1100)],'凭证引用',(1210,1005),True),
]
palette={'green':('#e9f4ed','#568b75'),'orange':('#fff2e4','#ba864b'),'purple':('#f2eff8','#8d80a7')}
svg=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" role="img" aria-labelledby="arch-title arch-desc"><title id="arch-title">MyAgent 详细技术架构</title><desc id="arch-desc">产品入口和编排进入应用服务，由唯一运行内核组织上下文、模型、工具和权限；执行环境独立，状态和扩展通过接口接入。</desc><defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9" fill="#4b7568"/></marker></defs><rect width="{W}" height="{H}" fill="#fffefb"/>']
svg += ['<g font-family="-apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif" fill="#203c34">', '<text x="35" y="39" font-size="25" font-weight="700">MyAgent / 详细技术架构</text>', '<text x="1205" y="38" font-size="14">实线：主调用　虚线：协作 / 返回</text>', '<rect x="385" y="385" width="780" height="600" rx="16" fill="#f5f9f5" stroke="#b7cbbd" stroke-dasharray="7 5"/>', '<text x="405" y="410" font-size="16" fill="#506d61">后端进程内 · 稳定内核与显式接口</text>', '<rect x="385" y="1050" width="780" height="355" rx="16" fill="#fffaf3" stroke="#dcc39e"/>', '<text x="405" y="1078" font-size="16" fill="#795c34">执行边界 · 通过 ExecutionPort 更换环境</text>']
cells=['<mxCell id="0"/>','<mxCell id="1" parent="0"/>']
def cell(id,x,y,w,h,value,style):
    cells.append(f'<mxCell id="{id}" value="{escape(value,quote=True)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
cell('frame-core',385,385,780,600,'后端进程内 · 稳定内核与显式接口','rounded=1;html=1;fillColor=#f5f9f5;strokeColor=#b7cbbd;dashed=1;verticalAlign=top;spacingTop=10;fontSize=16')
cell('frame-exec',385,1050,780,355,'执行边界 · 通过 ExecutionPort 更换环境','rounded=1;html=1;fillColor=#fffaf3;strokeColor=#dcc39e;verticalAlign=top;spacingTop=10;fontSize=16')
# 显式折线路径避免自动布线穿过其他节点，输出两种格式时保持边的含义一致。
for i,(a,b,points,label,lp,dashed) in enumerate(edges):
    ps=' '.join(f'{x},{y}' for x,y in points)
    svg.append(f'<polyline points="{ps}" fill="none" stroke="#fffefb" stroke-width="7"/>')
    dash=' stroke-dasharray="6 5"' if dashed else ''
    svg.append(f'<polyline points="{ps}" fill="none" stroke="#4b7568" stroke-width="2"{dash} marker-end="url(#arrow)"/>')
    if label: svg.append(f'<text x="{lp[0]}" y="{lp[1]}" font-size="14" fill="#537263">{escape(label)}</text>')
    ways=''.join(f'<mxPoint x="{x}" y="{y}"/>' for x,y in points)
    style=f'edgeStyle=orthogonalEdgeStyle;html=1;rounded=0;endArrow=block;strokeColor=#4b7568;dashed={int(dashed)}'
    cells.append(f'<mxCell id="e{i}" value="{escape(label)}" style="{style}" edge="1" parent="1" source="{a}" target="{b}"><mxGeometry relative="1" as="geometry"><Array as="points">{ways}</Array></mxGeometry></mxCell>')
for n in nodes:
    x,y,w,h=n['x'],n['y'],n['w'],n['h']; fill,stroke=palette[n['tone']]
    svg.append(f'<g><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{stroke}"/><text x="{x+16}" y="{y+30}" font-size="19" font-weight="650">{escape(n["title"])}</text>')
    for j,line in enumerate(n['lines']): svg.append(f'<text x="{x+16}" y="{y+57+j*23}" font-size="15" fill="#50685e">{escape(line)}</text>')
    svg.append('</g>')
    value='<b>'+n['title']+'</b><br>'+ '<br>'.join(n['lines'])
    cell(n['id'],x,y,w,h,value,f'rounded=1;html=1;fillColor={fill};strokeColor={stroke};align=left;verticalAlign=top;spacing=15;fontSize=16;fontColor=#203c34')
svg += ['<text x="35" y="1440" font-size="16" font-weight="650">设计约束</text>', '<text x="35" y="1470" font-size="15">状态单一归属 · Hook 后重新校验 · 外部动作结果未知先对账 · 取消停止派发并收拢执行 · 模型结束后仍需产物验收</text>', '</g></svg>']
xml='<mxfile host="myagent" version="24.7.17"><diagram id="architecture" name="MyAgent 详细架构"><mxGraphModel page="1" pageWidth="1540" pageHeight="1500"><root>'+''.join(cells)+'</root></mxGraphModel></diagram></mxfile>'
(ROOT/'diagrams/agent-architecture.svg').write_text(''.join(svg))
(ROOT/'diagrams/agent-architecture.drawio').write_text(xml)
(ROOT/'diagrams/architecture-spec.json').write_text(json.dumps({'width':W,'height':H,'nodes':nodes,'edges':edges},ensure_ascii=False,indent=2))
print(f'Created detailed SVG and Draw.io: {len(nodes)} components, {len(edges)} edges')
