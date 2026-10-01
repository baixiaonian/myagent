/**
 * 轻量多 Agent 实现图：用团队关系与两个局部展开解释创建、持久通信和统一交付。
 * 图源只使用固定示例，不读取会话或凭证；输出 SVG、可编辑 Excalidraw 及自审 PNG。
 * 创建的是成员身份/内部会话，成员复用同一个 runAgent；箭头不表示克隆 OS 进程。
 */
import { canvas } from '/Users/tbsg/.codex/skills/jemicy-zjm-excalidraw-diagram/render/freedraw.mjs';
const P = {
  ink: '#243649', muted: '#738295', line: '#DCE4EC', light: '#F7F9FC',
  blue: '#3477B5', blueFill: '#EDF5FC', blueLine: '#AFCFE9',
  purple: '#8061AA', purpleFill: '#F5F0FB', purpleLine: '#CCB9E4',
  green: '#2D8B78', greenFill: '#ECF7F3', greenLine: '#A9D4C7',
  amber: '#A87931', amberFill: '#FFF6E7', amberLine: '#E5CEAA',
};
const c = canvas({background:'#FFFFFF',font:'normal',fontSize:22,roughness:0,strokeWidth:1.5,stroke:P.line});
function text(x,y,str,size=22,color=P.ink,limit=1300) {
  if (Math.max(...str.split('\n').map(s=>c.textWidth(s,size)))>limit) throw new Error(`文字超宽 ${str}`);
  c.text(x,y,str,{fontSize:size,color});
}
function left(x,y,str,size=22,color=P.ink) {text(x+c.textWidth(str,size)/2,y,str,size,color);}
function box(x,y,w,h,fill='#FFF',stroke=P.line) {c.rect(x,y,w,h,{fill,stroke,round:true});}
function arrow(pts,color=P.blue,both=false,dashed=false) {
  c.arrow(pts,{curve:false,stroke:color,strokeWidth:2.6,head:'triangle',...(both?{tail:'triangle'}:{}),strokeStyle:dashed?'dashed':'solid'});
}
function chip(x,y,w,str,fill,color,size=19) {box(x,y,w,30,fill,'transparent');text(x+w/2,y+15,str,size,color,w-12);}
function badge(x,y,n,color) {c.circle(x,y,18,{fill:color,stroke:'transparent'});text(x,y,n,21,'#FFF');}
// 统一的成员图标与循环标签表示同一实现，而非三个互不相干的工作流引擎。
function bot(color) {
  box(0,0,42,33,'#FFF',color);
  c.circle(12,15,3,{fill:color,stroke:'transparent'});c.circle(30,15,3,{fill:color,stroke:'transparent'});
  c.line([[12,25],[30,25]],{stroke:color});c.line([[21,-8],[21,0]],{stroke:color});
  c.circle(21,-10,2.5,{fill:color,stroke:'transparent'});
}
function agent(title,sub,session,color,fill) {
  box(0,0,330,178,fill,color);
  c.place(22,31,()=>bot(color));left(84,46,title,30,color);
  text(165,88,sub,22,P.ink,300);
  text(165,122,session,20,P.muted,300);
  chip(79,143,172,'runAgent 循环', '#FFF',color,20);
}
function envelope(color) {
  box(0,0,36,25,'#FFF',color);
  c.line([[0,0],[18,13],[36,0]],{stroke:color});
}
function down(x,y1,y2,color) {arrow([[x,y1],[x,y2]],color);}

c.rect(0,0,1360,1580,{fill:'#FFF',stroke:'transparent'});
left(56,43,'MYAGENT  /  LIGHTWEIGHT TEAMS',17,P.muted);
left(56,98,'一个主 Agent，多个独立成员',40);
left(56,141,'模型自主分工 · 同一个循环 · 共享项目 · 持久通信',22,P.muted);

// 上半张先给关系全貌：蓝线创建，紫线通信；中间收件箱是应用服务，不是另一个 Agent。
box(535,181,290,56,P.light);
text(680,208,'用户 · 提问与最终交付',23);
arrow([[680,239],[680,267]],P.muted,true);
c.place(515,274,()=>agent('主 Agent','负责协调，也可以亲自执行','主会话 · 自己的上下文',P.blue,P.blueFill));
arrow([[512,329],[100,329],[100,465],[221,465],[221,492]],P.blue);
arrow([[849,329],[1260,329],[1260,465],[1139,465],[1139,492]],P.blue);
chip(104,289,234,'1 · spawn_agent',P.blueFill,P.blue,23);
chip(1020,289,190,'按需创建成员',P.blueFill,P.blue,22);
text(292,393,'名称 · 角色 · 任务',22,P.blue,300);
text(292,425,'可选背景范围',21,P.muted,300);
text(1078,393,'仅主 Agent 可创建',22,P.blue,300);
text(1078,425,'不固定“规划 / 执行”角色',20,P.muted,330);
c.place(56,504,()=>agent('成员 A · 分析员','可以执行、提问与回应','内部会话 A · 独立上下文',P.green,P.greenFill));
c.place(974,504,()=>agent('成员 B · 复核员','可以执行、提问与回应','内部会话 B · 独立上下文',P.green,P.greenFill));
box(491,510,378,166,P.purpleFill,P.purpleLine);
text(680,548,'持久收件箱',29,P.purple,350);
text(680,590,'主 ↔ 成员     成员 ↔ 成员',23,P.purple,350);
text(680,633,'TeamService 负责投递',21,P.muted,350);
arrow([[680,455],[680,506]],P.purple,true);
left(703,479,'请求 / 回执',18,P.purple);
arrow([[395,595],[481,595]],P.purple,true);
arrow([[879,595],[964,595]],P.purple,true);
text(438,569,'直发',19,P.purple,90);text(921,569,'直发',19,P.purple,90);
text(680,704,'成员直接交流，无需主 Agent 转述；会话内可复用，空闲时不调用模型。',22,P.muted,1248);

// 局部展开一：一次工具调用的意图与回执原子登记，再经中立端口复用现有 ChatService。
box(56,746,596,440,'#FCFDFF',P.blueLine);
badge(91,781,'1',P.blue);left(122,782,'创建：先保存，再启动',28,P.blue);
box(88,820,532,72,P.blueFill,'transparent');
text(354,843,'spawn_agent：定义一个成员',20,P.blue,508);
text(354,875,'名称 / 角色 / 任务 / 背景范围',21,P.ink,508);
down(354,896,918,P.blue);
box(88,924,532,104,'#FFF',P.blueLine);
left(110,948,'TeamService · 同一事务提交',23,P.blue);
const createItems=[['成员身份','内部会话'],['背景快照','待启动意图＋调用回执']];
createItems.forEach((row,i)=>{text(213,978+i*28,row[0],20,P.ink,215);text(458,978+i*28,row[1],20,P.ink,280);});
down(354,1033,1058,P.blue);
box(88,1064,532,72,P.blueFill,'transparent');
text(354,1087,'提交后，由维护器启动成员',22,P.blue,508);
text(354,1117,'ChatService → 独立成员 Run → runAgent',21,P.ink,508);
text(354,1160,'立即返回成员 ID，不等待任务完成',21,P.muted,540);

// 局部展开二：用真正的调用名和 replyTo 标出投递，不把入队误画为模型已经阅读。
box(684,746,620,440,'#FEFCFF',P.purpleLine);
badge(719,781,'2',P.purple);left(750,782,'通信：消息何时进入模型？',28,P.purple);
box(716,820,556,72,P.purpleFill,'transparent');
c.place(735,842,()=>envelope(P.purple));
text(1015,843,'A 调用 send_message → B',24,P.purple,465);
text(1015,875,'request：“请独立核对总额”',21,P.ink,465);
down(994,896,918,P.purple);
box(716,924,556,65,'#FFF',P.purpleLine);
text(994,947,'SQLite 先保存，再确认“已入队”',23,P.purple,534);
text(994,975,'id · from / to · kind · content · replyTo',19,P.muted,534);
down(994,994,1014,P.purple);
box(716,1020,556,78,P.purpleFill,'transparent');
text(994,1044,'B：上一批工具结果完整落库',23,P.purple,534);
text(994,1077,'读取收件箱＋保存检查点 → 下一次模型请求',20,P.ink,534);
down(994,1103,1120,P.purple);
c.place(731,1129,()=>envelope(P.green));
text(1004,1138,'B 回复 A，用 replyTo 关联原消息',22,P.green,502);
text(994,1169,'空闲成员：request 唤醒；inform / result 不唤醒',19,P.muted,572);

// 交付闸口只有生命周期判断，不把“任务成功”伪装成额外质量模型的验收。
box(56,1220,1248,122,P.amberFill,P.amberLine);
badge(91,1253,'3',P.amber);left(122,1253,'统一交付',26,P.amber);
chip(313,1236,184,'还有成员在工作', '#FFF',P.amber,21);
arrow([[505,1251],[549,1251]],P.amber);
chip(557,1236,205,'waiting_agents','#FFF',P.amber,22);
arrow([[770,1251],[813,1251]],P.amber);
chip(821,1236,444,'结果到达 → 主 Agent 继续处理','#FFF',P.amber,22);
text(680,1293,'所有工作已收拢，才提交最终回答；主 Agent 可以停止不再需要的成员。',23,P.ink,1180);
text(680,1321,'停止主任务会取消本轮成员工作，已发生的文件修改不会自动回滚。',20,P.muted,1180);

// 三块共用底座对应真实治理、独立上下文和持久恢复；控制循环和权限仍是已有实现。
const bases=[
  {x:56,w:398,title:'共用执行治理',a:'文件 / 命令 → 权限与审批',b:'资源锁＋沙箱 → 同一项目目录',color:P.green},
  {x:477,w:407,title:'独立上下文，共享预算',a:'任务 / 最近轮次 / 完整可见历史',b:'默认 8 成员 · 全局模型并发 4',color:P.blue},
  {x:907,w:397,title:'持久恢复与团队面板',a:'成员 / 消息 / 回执 / 检查点',b:'SQLite v11 · 重启不自动重放',color:P.purple},
];
for(const b of bases){box(b.x,1374,b.w,126,P.light);left(b.x+20,1404,b.title,25,b.color);text(b.x+b.w/2,1443,b.a,20,P.ink,b.w-24);text(b.x+b.w/2,1476,b.b,20,P.muted,b.w-24);}
text(680,1536,'一个 runAgent 实现，多份独立运行状态  ·  当前范围：本机 / 同项目 / 单层团队',21,P.muted,1248);
await c.save(new URL('./agent-teams.excalidraw',import.meta.url).pathname);
console.info(`已生成 ${c.count} 个可编辑元素。`);
