/**
 * 多 Agent 工具调用展开图：区分模型提出 tool_call、后端处理器及普通运行方法。
 * 作为上版关系图的补充，回答 spawn_agent 如何启动成员、如何直接通信、三种消息的责任以及工具目录差异。
 * 只生成固定示例图，不读取用户历史或运行配置；SVG 为交付，PNG 为布局自审。
 */
import {canvas} from '/Users/tbsg/.codex/skills/jemicy-zjm-excalidraw-diagram/render/freedraw.mjs';
const P={ink:'#24364A',muted:'#768497',line:'#DAE3EC',gray:'#F6F8FB',blue:'#3577B2',bf:'#EDF5FC',bl:'#B4CFE6',purple:'#7F5BA9',pf:'#F4EEFA',pl:'#CBB7E3',green:'#2A8776',gf:'#ECF7F3',gl:'#AED6C9',orange:'#A6772F',of:'#FFF5E5'};
const c=canvas({background:'#FFF',font:'normal',fontSize:22,roughness:0,strokeWidth:1.5,stroke:P.line});
function box(x,y,w,h,fill='#FFF',stroke=P.line){c.rect(x,y,w,h,{fill,stroke,round:true});}
function txt(x,y,s,size=22,color=P.ink,max=1380){if(Math.max(...s.split('\n').map(v=>c.textWidth(v,size)))>max)throw new Error(`文字超宽: ${s}`);c.text(x,y,s,{fontSize:size,color});}
function left(x,y,s,size=22,color=P.ink){txt(x+c.textWidth(s,size)/2,y,s,size,color);}
function arrow(points,color=P.blue,dashed=false){c.arrow(points,{curve:false,stroke:color,strokeWidth:2.6,head:'triangle',strokeStyle:dashed?'dashed':'solid'});}
function down(x,y1,y2,color=P.blue){arrow([[x,y1],[x,y2]],color);}
function chip(x,y,w,s,color=P.blue,fill=P.bf,size=21){box(x,y,w,32,fill,'transparent');txt(x+w/2,y+16,s,size,color,w-16);}
function title(n,x,y,s,color){c.circle(x+17,y,18,{fill:color,stroke:'transparent'});txt(x+17,y,n,22,'#FFF');left(x+50,y,s,29,color);}

c.rect(0,0,1480,2050,{fill:'#FFF',stroke:'transparent'});
left(50,42,'MYAGENT / 工具与运行时',18,P.muted);
left(50,100,'模型提出调用，后端真正创建与通信',40);
left(50,144,'看清三个边界：工具调用请求 → 后端执行 → 另一个 Agent 的模型请求',24,P.muted);

// 创建泳道：左边是模型意图，中间是后端普通代码，右边是新运行状态和后续独立模型请求。
box(50,182,1380,576,'#FCFDFF',P.bl);
title('1',74,218,'创建成员：spawn_agent 是主 Agent 的工具',P.blue);
box(74,270,290,165,P.bf,P.bl);
txt(219,304,'主 Agent 的模型',28,P.blue,264);
txt(219,348,'在工具列表中看到',22,P.ink,264);
chip(121,373,196,'spawn_agent',P.blue,'#FFF',24);
arrow([[371,349],[433,349]],P.blue);
txt(402,321,'请求',19,P.blue,60);
left(87,475,'调用参数',22,P.muted);
left(87,508,'名称：分析员 A',22);
left(87,539,'角色：负责数据分析',22);
left(87,570,'任务＋初始背景范围',22);
box(74,616,290,83,P.bf,P.bl);
txt(219,641,'工具回传：已入队',23,P.blue,264);
txt(219,677,'agentId=A · queued',20,P.muted,264);

box(444,270,605,429,P.gray);
txt(746,294,'后端程序 · 普通 TypeScript 方法',22,P.muted,566);
box(466,316,561,70,'#FFF',P.bl);
txt(746,339,'ToolService：校验并分派',25,P.blue,530);
txt(746,369,'检查名称、参数与调用者身份',21,P.muted,530);
down(746,391,408);
box(466,414,561,94,'#FFF',P.bl);
txt(746,439,'TeamService：创建并持久化',25,P.blue,530);
txt(746,474,'成员身份＋内部会话＋任务＋待启动意图',21,P.ink,530);
txt(746,497,'与工具成功回执同一事务保存',20,P.muted,530);
// 回传工具结果与真正开始成员运行是两条分支，主模型不用等待成员完成。
arrow([[466,480],[410,480],[410,656],[371,656]],P.blue,true);
txt(746,529,'事务提交后',19,P.muted,530);
down(746,539,552);
box(466,558,561,120,P.of,'#E7D1AE');
txt(746,583,'程序自动启动，不用再调用“启动工具”',24,P.orange,538);
txt(746,620,'maintain → startMember → ChatService.start',20,P.ink,536);
txt(746,656,'创建成员 Run → 执行 runAgent(...)',23,P.ink,536);

box(1114,270,290,186,P.gf,P.gl);
txt(1259,305,'新成员 A 的状态',26,P.green,264);
txt(1259,346,'成员身份 / 角色',22,P.ink,264);
txt(1259,383,'独立内部会话',22,P.ink,264);
txt(1259,421,'独立上下文与历史',22,P.ink,264);
arrow([[1036,458],[1080,458],[1080,352],[1104,352]],P.green);
box(1114,561,290,138,P.gf,P.gl);
txt(1259,590,'成员 A 的模型',27,P.green,266);
txt(1259,631,'接收角色＋任务＋工具',21,P.ink,266);
txt(1259,670,'回答，或继续调用工具',21,P.ink,266);
down(1259,462,554,P.green);
arrow([[1032,654],[1103,654]],P.green);
txt(1070,626,'请求',18,P.green,80);
txt(740,728,'主 Agent 拿到 ID 就能继续；成员复用同一后端和模型连接，各自运行自己的循环。',23,P.muted,1320);

// 通信泳道：发消息是工具动作，收信是运行时边界注入；回复仍经同一路径。
box(50,795,1380,717,'#FEFCFF',P.pl);
title('2',74,832,'直接通信：发送用工具，接收由运行时完成',P.purple);
box(74,878,290,177,P.pf,P.pl);
txt(219,909,'A 的模型',28,P.purple,268);
chip(111,938,216,'send_message',P.purple,'#FFF',23);
txt(219,999,'目标 B · 类型 request',21,P.ink,266);
txt(219,1035,'正文：“请核对总额”',21,P.ink,266);
arrow([[372,972],[438,972]],P.purple);txt(405,945,'调用',18,P.purple,74);
box(446,878,557,177,'#FFF',P.pl);
txt(724,910,'ToolService → TeamService',24,P.purple,530);
box(477,939,494,71,P.pf,'transparent');
txt(724,964,'把消息保存进 B 的持久收件箱',24,P.purple,472);
txt(724,994,'id · from / to · kind · content · replyTo',19,P.muted,472);
txt(724,1035,'先保存，再向 A 回传“已入队”',22,P.ink,530);
arrow([[1010,972],[1103,972]],P.purple);txt(1058,945,'投递',18,P.purple,92);
box(1114,878,290,198,P.gf,P.gl);
txt(1259,909,'B 的运行时',27,P.green,268);
txt(1259,952,'上一批工具已落库',22,P.ink,268);
txt(1259,989,'读取消息、存检查点',21,P.ink,268);
chip(1135,1028,247,'下次请求 B 的模型',P.green,'#FFF',21);
arrow([[1259,1081],[1259,1120],[219,1120],[219,1060]],P.purple,true);
chip(417,1104,657,'B 回复：send_message → 同一收件箱 → A',P.purple,'#FEFCFF',20);
// 三类消息保留不同来源和语义：模型请求/信息不等于系统确认的运行终态。
const messageTypes = [
 {x:74,w:426,title:'request · 请求',color:P.green,fill:P.gf,line:P.gl,
  source:'Agent 通过 send_message 发送',purpose:'要求接收方处理任务',example:'“请再核查这份报告”',action:'空闲 → 启动新的 Run',note:'沿用原成员身份与历史'},
 {x:519,w:426,title:'inform · 信息 / 回复',color:P.purple,fill:P.pf,line:P.pl,
  source:'Agent 通过 send_message 发送',purpose:'回复、补充资料或报告进度',example:'“总额 300，还在检查”',action:'空闲 → 保存，不启动',note:'收到回复不代表任务已经完成'},
 {x:964,w:440,title:'result · 完成回执',color:P.orange,fill:P.of,line:'#E7D1AE',
  source:'后端程序根据真实运行状态生成',purpose:'运行状态＋回答 / 错误',example:'succeeded / failed / cancelled',action:'空闲 → 保存，不启动',note:'发给主 Agent 和对应请求方'},
];
for (const m of messageTypes) {
 box(m.x,1164,m.w,258,m.fill,m.line);
 txt(m.x+m.w/2,1196,m.title,27,m.color,m.w-30);
 txt(m.x+m.w/2,1237,m.source,20,P.ink,m.w-24);
 txt(m.x+m.w/2,1271,m.purpose,22,P.ink,m.w-24);
 txt(m.x+m.w/2,1307,m.example,21,P.muted,m.w-24);
 chip(m.x+18,1340,m.w-36,m.action,m.color,'#FFF',22);
 txt(m.x+m.w/2,1393,m.note,20,P.muted,m.w-24);
}
txt(740,1457,'运行中的 Agent 在安全边界读取；处于 waiting_agents 的 Agent 收到消息可以继续。',22,P.ink,1320);
txt(740,1490,'send_message 只发送 request / inform；result 由程序维护，模型不能伪造完成状态。',21,P.purple,1320);

c.at(0,300,()=>{
// 工具表对应 TeamService.allowed 的后端限制；能力注册相同，不表示每次可见目录完全相同。
box(50,1250,1380,402,'#FFF',P.line);
title('3',74,1287,'主 Agent 和成员：同一工具体系，目录与权限不同',P.ink);
box(74,1324,1330,43,P.gray,'transparent');
left(93,1346,'工具 / 能力',22,P.ink);txt(1020,1346,'主 Agent',22,P.blue);txt(1254,1346,'成员 Agent',22,P.green);
const rows=[
 ['文件 / 命令 / MCP / Skill 等业务工具','按配置提供','按配置提供'],
 ['send_message / list_agents / wait_agents','可用','可用'],
 ['read_agent_history','可查看成员','自身与明确共享'],
 ['spawn_agent / stop_agent','可用','不可用'],
 ['update_memory（修改长期记忆）','可用','不可用'],
];
rows.forEach((r,i)=>{const y=1393+i*48;if(i%2===0)box(74,y-23,1330,46,'#FAFBFD','transparent');left(93,y,r[0],22);txt(1020,y,r[1],21,P.blue,230);txt(1254,y,r[2],21,r[2]==='不可用'?P.muted:P.green,270);});
txt(740,1630,'每次按角色、项目与加载状态生成目录；执行前再检查权限与身份，模型不能伪造主 Agent 身份。',21,P.muted,1320);
txt(740,1697,'图中的 ToolService / TeamService / ChatService 是后端模块，不是新的 Agent，也不是模型需要调用的工具。',22,P.ink,1380);
});
await c.save(new URL('./agent-teams-tool-flow.excalidraw',import.meta.url).pathname);
console.info(`已生成 ${c.count} 个可编辑元素。`);
