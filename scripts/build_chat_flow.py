"""生成当前聊天链路的 SVG / Draw.io；不读取配置、凭证或研究快照。"""
from pathlib import Path
from html import escape
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'diagrams'
W, H = 1800, 1550
C = {'ink':'#172D3B','muted':'#526779','blue':'#3570BC','green':'#238568','purple':'#7852A5','amber':'#AA7228','gray':'#7B8793'}
PALETTE = {'blue':('#F0F6FF','#9EBBE0'),'green':('#EFF9F5','#93C7B5'),'purple':('#F6F1FC','#C4AEDF'),'amber':('#FFF8EC','#DEBE8B'),'gray':('#F3F5F7','#CDD4DC')}
svg=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc"><title id="title">MyAgent 当前聊天链路与原设计、代码提交的对应关系</title><desc id="desc">从 Web 和 SDK 发送问题，经本地 Server、Application、Kernel、模型适配器调用用户模型；回答回到应用层，持久化至 SQLite 后经 SSE 和 SDK 展示。配置与凭证独立保存，完整 Agent 扩展仍为骨架。</desc><defs>']
for name in ['blue','green','purple']:
 svg.append(f'<marker id="arrow-{name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="{C[name]}"/></marker>')
svg+=['</defs>',f'<rect width="{W}" height="{H}" fill="#FCFDFE"/>','<g font-family="PingFang SC,Microsoft YaHei,Arial,sans-serif">']
mx=ET.Element('mxfile',{'host':'myagent','version':'24.7.17'})
diag=ET.SubElement(mx,'diagram',{'id':'chat-v1','name':'当前聊天链路'})
model=ET.SubElement(diag,'mxGraphModel',{'page':'1','pageWidth':str(W),'pageHeight':str(H)})
root=ET.SubElement(model,'root');ET.SubElement(root,'mxCell',{'id':'0'});ET.SubElement(root,'mxCell',{'id':'1','parent':'0'})
nodes={};texts=[];edges=[];source_paths=set()

def cell(id,x,y,w,h,value,style):
 e=ET.SubElement(root,'mxCell',{'id':id,'value':value,'style':style,'vertex':'1','parent':'1'})
 ET.SubElement(e,'mxGeometry',{'x':str(x),'y':str(y),'width':str(w),'height':str(h),'as':'geometry'})

def text(id,x,y,value,size=18,color=None,bold=False):
 color=color or C['ink'];svg.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{700 if bold else 400}" fill="{color}">{escape(value)}</text>')
 cell(id,x,y-size, W-x-20,size+10,escape(value),f'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontFamily=PingFang SC;fontSize={size};fontColor={color};fontStyle={1 if bold else 0};spacing=0')
 texts.append({'x':x,'y':y,'text':value,'size':size})

def card(id,x,y,w,h,title,tag,lines,paths=(),tone='blue'):
 fill,stroke=PALETTE[tone];nodes[id]={'x':x,'y':y,'w':w,'h':h}
 svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
 svg.append(f'<rect x="{x}" y="{y+16}" width="4" height="25" rx="2" fill="{C[tone]}"/>')
 labels=[(title,22,C['ink'],True),(tag,15,C[tone],False)]
 labels += [(s,17,C['muted'],False) for s in lines]
 yy=y+36
 for i,(s,sz,col,bold) in enumerate(labels):
  if i==1: yy=y+64
  elif i>=2:yy=y+101+(i-2)*27
  svg.append(f'<text x="{x+19}" y="{yy}" font-size="{sz}" font-weight="{700 if bold else 400}" fill="{col}">{escape(s)}</text>')
 for i,p in enumerate(paths):
  yy=y+h-19-(len(paths)-1-i)*20
  svg.append(f'<text x="{x+19}" y="{yy}" font-family="Menlo,monospace" font-size="12.5" fill="{C[tone]}">{escape(p)}</text>')
  if p.startswith(('apps/','packages/','migrations/')):source_paths.add(p)
 # Editable text uses the same explicit coordinates as SVG, avoiding HTML auto-wrap drift.
 cell(id,x,y,w,h,'',f'rounded=1;arcSize=10;html=1;fillColor={fill};strokeColor={stroke}')
 for i,(value,sz,col,bold) in enumerate(labels):
  yy=y+36 if i==0 else y+64 if i==1 else y+101+(i-2)*27
  cell(f'{id}-text-{i}',x+19,yy-sz,w-38,sz+6,escape(value),f'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontFamily=PingFang SC;fontSize={sz};fontColor={col};fontStyle={1 if bold else 0};spacing=0')
 for i,p in enumerate(paths):
  yy=y+h-19-(len(paths)-1-i)*20
  cell(f'{id}-path-{i}',x+19,yy-12.5,w-38,18,escape(p),f'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontFamily=Menlo;fontSize=12.5;fontColor={C[tone]};spacing=0')

def edge(a,b,pts,tone='blue',label=None,lp=None,dashed=False):
 ident=f'edge-{len(edges)}';color=C[tone]
 svg.append(f'<polyline points="{" ".join(f"{x},{y}" for x,y in pts)}" fill="none" stroke="{color}" stroke-width="2.5"'+(' stroke-dasharray="6 5"' if dashed else '')+f'/>')
 # Explicit arrowheads keep native macOS SVG rasterization faithful.
 sx,sy=pts[-2];tx,ty=pts[-1];dx,dy=tx-sx,ty-sy;length=(dx*dx+dy*dy)**0.5;ux,uy=dx/length,dy/length
 ax,ay=tx-11*ux,ty-11*uy
 svg.append(f'<polygon points="{tx},{ty} {ax-5*uy},{ay+5*ux} {ax+5*uy},{ay-5*ux}" fill="{color}"/>')
 if label:
  x,y=lp;svg.append(f'<text x="{x}" y="{y}" font-size="16" fill="{color}">{escape(label)}</text>')
 na,nb=nodes[a],nodes[b]
 sx,sy=pts[0];tx,ty=pts[-1]
 style=f'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;strokeWidth=2.5;strokeColor={color};fontColor={color};fontSize=16;dashed={int(dashed)};exitX={(sx-na["x"])/na["w"]};exitY={(sy-na["y"])/na["h"]};entryX={(tx-nb["x"])/nb["w"]};entryY={(ty-nb["y"])/nb["h"]}'
 e=ET.SubElement(root,'mxCell',{'id':ident,'value':label or '', 'style':style,'edge':'1','parent':'1','source':a,'target':b})
 g=ET.SubElement(e,'mxGeometry',{'relative':'1','as':'geometry'});arr=ET.SubElement(g,'Array',{'as':'points'})
 for x,y in (pts[1:-1] or [((pts[0][0]+pts[-1][0])/2,(pts[0][1]+pts[-1][1])/2)]):ET.SubElement(arr,'mxPoint',{'x':str(x),'y':str(y)})
 edges.append({'source':a,'target':b,'points':pts,'label':label})

text('heading',40,53,'MyAgent · 当前聊天机器人，一张图读懂设计如何落地',32,bold=True)
text('subheading',40,87,'实现快照：df8169e  /  本地单用户 Web Chat v1  /  8 个聊天模块已实现，7 个 workspace 仍为骨架',18,C['muted'])
card('commit1',40,112,840,94,'30b326b · 初始化工程骨架','15 个 workspace + 原始架构报告 + AGENTS / docs + 8 项工程测试',[],tone='gray')
card('commit2',920,112,840,94,'df8169e · 实现聊天产品','补齐下方彩色链路、持久化与交互 + 32 项工程测试 + Web / Docker 验收',[],tone='green')
card('contracts',40,226,1720,68,'Contracts · 全链路共享协议','Session / Message / Run / Settings / ChatEvent / AppError   ·   packages/contracts/src/index.ts   ·   这是数据约定，不是运行步骤',[],tone='purple')
text('send-label',40,330,'发送问题 →',19,C['blue'],True)
text('legend',1190,330,'蓝：请求调用     绿：回答回传     紫：本地状态',16,C['muted'])
card('web',40,350,320,260,'① 输入问题 · Web / SDK','对应原设计 01：产品入口',[
 'App 收集问题与当前会话版本','ChatClient.send / regenerate','requestId 防止重复提交','HTTP 命令返回 Run + 快照'],['apps/web/src/App.tsx','packages/sdk/src/index.ts'])
card('server',390,350,320,260,'② 接入与装配 · Server','原设计：本地后端组合根',[
 'Fastify：JSON / Host / Origin','POST /sessions/:id/runs','构造并注入仓储、凭证、模型','生产模式同时托管 Web'],['apps/server/src/','bootstrap/index.ts'])
card('app',740,350,320,260,'③ 开始运行 · Application','对应原设计 02：应用服务',[
 'ChatService.start：检查幂等','读取历史与启动时配置快照','先 buildContext，再 beginRun','原子保存问题 / 候选 / Run'],['packages/application/src/chat.ts'])
card('kernel',1090,350,320,260,'④ 组装与执行 · Kernel','对应原设计 04 上下文 + 03 内核',[
 'buildContext → runChat','系统词 + 当前问 + 最近完整轮','最多 20 轮 / 32,000 字符','每 Run 调模型一次；取消 / 超时'],['packages/kernel/src/','context/index.ts · runtime/index.ts'])
card('adapter',1440,350,320,260,'⑤ 模型通信 · Adapters','对应原设计 05：Model Gateway',[
 '实现 Kernel 定义的 ModelPort','OpenAI SDK Chat Completions','自定义 baseURL / model','流式文字；关闭自动重试'],['packages/adapters/src/','models/openai/index.ts'])
# External provider is explicitly separated from the local adapter.
card('provider',1440,672,320,74,'外部：用户配置的模型服务','目前已验收 DeepSeek；经网络请求',[],tone='gray')

card('view',40,785,320,240,'⑨ 显示答案 · SDK / Web','同一浏览器中的事件投影与渲染',[
 'subscribe 检查事件序号、去重','applyEvent 更新会话快照','React → Markdown / 代码复制','重新打开：先快照，再补读事件'],['packages/sdk/src/index.ts','apps/web/src/App.tsx'],tone='green')
card('sse',390,785,320,240,'⑧ 传回事件 · Server','持久事件 → SSE → 浏览器',[
 'GET /sessions/:id/events','每 250ms 读取已落库事件','按 seq / after 游标补读','断开订阅不会取消后台生成'],['apps/server/src/','bootstrap/index.ts'],tone='green')
card('buffer',740,785,320,240,'⑥ 收集答案 · Application','runChat 的 onText 回调',[
 '流式文本先汇入 buffer','约 250ms 调用 appendDelta','结束立即 flush + finishRun','成功 / 停止 / 失败明确终结'],['packages/application/src/chat.ts'],tone='green')
card('settings',1090,785,670,240,'连接与凭证 · SettingsService','原设计 Credentials：本版采用独立本地文件；应用层在运行开始前读取',[
 '设置页 → SDK → Server → SettingsService.save / test','baseURL、model、systemPrompt 存 SQLite；每次运行冻结连接配置','密钥保存为 credentials.json（0600）；读取设置只返回掩码','连接测试执行独立短请求，不写聊天历史'],['packages/application/src/settings.ts','packages/adapters/src/credentials/index.ts'],tone='amber')
card('state',740,1085,1020,195,'⑦ 本地状态 · State → SQLite Adapter','对应原设计 Session / Run + Storage：ChatStore 契约由 SqliteChatStore 实现',[
 'Drizzle + better-sqlite3 + WAL；增量内容与事件同事务落库，SSE 才能读取','~/.myagent/state.db 保存会话、消息、Run、事件和脱敏配置；唯一索引保护同会话单运行'],['packages/state/src/index.ts  →  packages/adapters/src/storage/sqlite/store.ts','migrations/0001_chat.sql'],tone='purple')
card('controls',40,1085,670,168,'当前代码中的控制与恢复','与上述主链路复用同一套 Run / 仓储',[
 '停止：cancel → AbortSignal → 模型；保留已生成文字','重新生成：候选成功才替换原答案；重启：running → interrupted','会话列表 / 读取 / 新建 / 重命名由 Server 直接访问 store'],tone='blue')
card('future',40,1320,1720,145,'灰色范围仍未实现 · 原架构是完整 Agent 目标，当前只打通文字聊天','原设计 06 Tool System / 07 Policy + Interaction / 08 Execution Gateway / Worker / MCP 均未接入聊天链路',[
 'Content：记忆 / 检索 / 产物　·　Extensions：Skill / Hook / Plugin　·　Orchestration：Workflow / 多 Agent',
 'Task / Invocation、CLI、Observability、testing 包仍是骨架；测试用假模型不代表这些产品模块已完成'],tone='gray')

for a,b,x in [('web','server',360),('server','app',710),('app','kernel',1060),('kernel','adapter',1410)]:edge(a,b,[(x,480),(x+30,480)])
edge('adapter','provider',[(1630,610),(1630,672)],label='HTTP 请求',lp=(1644,646))
edge('provider','adapter',[(1510,672),(1510,610)],'green')
edge('adapter','kernel',[(1440,572),(1410,572)],'green')
edge('kernel','buffer',[(1190,610),(1190,714),(900,714),(900,785)],'green','文字增量经 runChat 返回 onText', (915,700))
edge('buffer','state',[(900,1025),(900,1085)],'purple','先落库', (916,1060))
edge('state','sse',[(740,1163),(725,1163),(725,1056),(550,1056),(550,1025)],'green')
edge('sse','view',[(390,905),(360,905)],'green')
text('return-label',40,758,'← 回答返回：先保存，再展示',19,C['green'],True)
text('final-note',40,1501,'读图方法：①→⑤ 发起一次模型调用；⑥→⑨ 把回答可靠地送回页面。上下文由应用层先组装，模型不会直接向浏览器推送。',18,C['ink'])
text('source-note',40,1530,'设计编号沿用 agent-architecture.html / diagrams/agent-architecture.svg。完整源码定位与阶段差异见 docs/architecture/chat-flow.md。',15,C['muted'])
svg.append('</g></svg>')
OUT.mkdir(exist_ok=True)
(OUT/'chat-implementation-flow.svg').write_text(''.join(svg))
(OUT/'chat-implementation-flow.drawio').write_text(ET.tostring(mx,encoding='unicode').replace(' />','/>'))
# Only complete source paths are asserted here; cards split long paths for readability.
for p in ['apps/server/src/bootstrap/index.ts','packages/kernel/src/context/index.ts','packages/kernel/src/runtime/index.ts','packages/kernel/src/model/index.ts','packages/adapters/src/models/openai/index.ts','packages/adapters/src/storage/sqlite/store.ts',*source_paths]:
 if ' → ' not in p: assert (ROOT/p).exists(),p
print('Generated chat SVG / Draw.io:',len(nodes),'cards,',len(edges),'edges')
