/**
 * 七种多 Agent 协作图的唯一生成入口，属于研究讲解资产，不代表 MyAgent 已实现多 Agent。
 * 生成 SVG、Excalidraw、自审 PNG 与独立 HTML；各模式可组合，第七种属于接入维度。
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { drawing, P } from './parts-multi-agent-patterns.mjs';
import { gallery } from './multi-agent-gallery.mjs';
const output = new URL('./multi-agent-patterns/', import.meta.url);
await mkdir(output, { recursive: true });
const sources = {
  opencode: ['OpenCode · task', 'https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts'],
  hermes: ['Hermes · delegate_task', 'https://github.com/NousResearch/hermes-agent/blob/main/tools/delegate_tool.py'],
  codex: ['Codex · Agent runtime', 'https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/control.rs'],
  dsh: ['DSH · continuable subagent', 'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md'],
  team: ['DSH · Agent Teams（实验性）', 'https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/experimental/agent-team'],
  kanban: ['Hermes · Kanban', 'https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban/'],
  handoff: ['OpenAI Agents SDK · Handoffs', 'https://openai.github.io/openai-agents-python/handoffs/'],
  graph: ['LangGraph · Workflows', 'https://docs.langchain.com/oss/python/langgraph/workflows-agents'],
  crew: ['CrewAI · Processes', 'https://docs.crewai.com/en/concepts/processes'],
  chat: ['AutoGen · SelectorGroupChat', 'https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html'],
  provider: ['DSH · Codex Provider', 'https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-codex'],
  acp: ['DSH · ACP Provider', 'https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-acp'],
};
const figures = [
  { id: 1, slug: 'delegation', en: 'AGENT AS TOOL', title: '主 Agent 委派子任务',
    idea: '把一部分工作交给助手，结果交回主 Agent 汇总。', control: '主 Agent 决定分工',
    note: '同步等待或后台回送都属于委派；独立子任务可以并发。子 Agent 也运行自己的模型与工具循环。', refs: ['opencode', 'hermes'],
    draw({agent, arrow, person, document, text, tag, footer}) {
      person(150, 278); agent(630, 275, '主 Agent', {sub:'负责整体任务',w:240}); document(1110,275,'最终交付');
      arrow([[195,275],[500,275]]); tag(340,250,'用户任务');
      arrow([[758,275],[1040,275]],P.green); tag(910,250,'汇总结果',P.green,P.greenFill);
      for (const [x,title] of [[260,'助手 A'],[630,'助手 B'],[1000,'助手 C']]) {
        agent(x,525,title,{color:P.green,fill:P.greenFill,sub:'完成指定子任务'});
        const start=x===260?550:x===1000?710:610;
        arrow([[start,343],[start,387],[x-26,417],[x-26,457]]);
        arrow([[x+30,457],[x+30,407],[start+40,374],[start+40,343]],P.green,true);
      }
      text(630,651,'派出子任务 → 独立执行 → 收取结论 → 主 Agent 继续',23);
      footer('蓝色：委派    绿色虚线：结果返回    ·    每个助手有自己的上下文');
    } },
  { id:2,slug:'continuable',en:'PERSISTENT SUBAGENT',title:'保留子会话，持续协作',
    idea:'同一个助手，保留上下文；可以追问、补充和继续。',control:'消息驱动下一轮',
    note:'子会话有稳定身份。运行中投递、空闲唤醒等能力的边界依实现而异；图中两次工作沿用同一子会话。',refs:['codex','dsh'],
    draw({rect,text,left,arrow,tag,bot,loop,footer}) {
      rect(205,215,1005,118,P.blueFill,'transparent'); rect(205,419,1005,118,P.greenFill,'transparent');
      bot(108,247); text(108,301,'主 Agent',22); bot(108,453,P.green,P.greenFill); text(108,506,'同一助手',22);
      arrow([[227,274],[1187,274]],P.gray); arrow([[227,478],[1187,478]],P.gray);
      for(const [x,a,b,label,color] of [[300,282,411,'创建＋任务',P.blue],[570,411,282,'首轮结果',P.green],[800,282,411,'补充要求',P.purple],[1090,411,282,'继续反馈',P.green]]) {
        arrow([[x,a],[x,b]],color); tag(x,371,label,color,P.white);
      }
      for(const [x,title] of [[435,'第一次工作'],[945,'继续工作']]) {
        rect(x-96,444,192,66,P.white,P.green); loop(x-55,477,P.green); text(x+30,477,title,19,P.green);
      }
      rect(242,578,930,75,P.faint,P.line); left(267,614,'子会话 #A17',21,P.green);
      ['第一次任务','执行记录','补充要求','新的结果'].forEach((label,i)=>tag(538+i*158,615,label,P.muted,P.white,18));
      footer('时间从左向右    ·    再次沟通仍使用同一身份和历史，无需每次新建助手');
    } },
  { id:3,slug:'teams',en:'SHARED TASK BOARD',title:'团队任务板＋独立执行',
    idea:'各自推进任务，靠共享状态和定向消息协调。',control:'成员各自推进',
    note:'Teams 在此专指共享任务板式协作。依赖可以限制开始时机，但没有统一发言顺序；任务板不等于文件锁。DSH 对应模块仍为实验性。',refs:['team','kanban'],
    draw({rect,agent,arrow,text,tag,box,footer,dot}) {
      box(173,292,204,100,'负责人','创建任务与分工'); arrow([[280,292],[419,292]]);
      rect(430,195,440,192,P.faint,P.line); text(650,226,'共享任务板',25);
      [['前端','页面开发','进行中',P.blue],['后端','登录接口','进行中',P.green],['测试','联合验证','等接口',P.orange]].forEach(([role,task,status,color],i)=>{
        const y=265+i*43; rect(448,y-17,404,35,P.white,'transparent'); dot(464,y,4,color);
        text(506,y,role,18,color); text(634,y,task,18); text(796,y,status,17,color);
      });
      tag(1057,271,'状态供成员查询',P.purple,P.purpleFill); tag(1057,320,'依赖决定何时开工',P.orange,P.orangeFill);
      for(const [x,name,color,fill,sub] of [[220,'前端 Agent',P.blue,P.blueFill,'持续写页面'],[650,'后端 Agent',P.green,P.greenFill,'持续写接口'],[1070,'测试 Agent',P.orange,P.orangeFill,'依赖就绪后验证']]) {
        arrow([[x<400?470:x>900?830:650,396],[x,443],[x,477]],P.purple,true);
        agent(x,545,name,{color,fill,sub,w:244});
      }
      arrow([[337,613],[337,661],[533,661],[533,613]],P.purple,true); tag(435,661,'定向沟通',P.purple,P.purpleFill);
      arrow([[776,545],[938,545]],P.green); tag(860,506,'接口完成',P.green,P.greenFill,17);
      footer('前端与后端可同时运行各自的 Loop；需要信息时发消息，依赖未完成时等待');
    } },
  { id:4,slug:'handoff',en:'CONTROL HANDOFF',title:'交出控制权，专家接管',
    idea:'当前对话交给专业 Agent，由它继续直接处理。',control:'切换当前负责人',
    note:'Handoff 改变当前执行者。是否跨用户回合保持负责人由应用管理；它不要求专家完成后返回原 Agent。专业身份不自动赋予执行授权。',refs:['handoff'],
    draw({agent,person,arrow,tag,rect,text,document,footer}) {
      person(167,375); agent(465,250,'接待 Agent',{sub:'识别退款需求',color:P.gray,fill:P.grayFill});
      agent(960,376,'售后 Agent',{sub:'接管本轮对话',color:P.purple,fill:P.purpleFill,w:246});
      arrow([[207,338],[292,250],[345,250]]); tag(270,268,'1. 初次请求');
      arrow([[585,249],[716,249],[804,345],[827,345]],P.purple); tag(753,220,'2. transfer_to…',P.purple,P.purpleFill);
      tag(959,277,'当前执行者',P.purple,P.purpleFill);
      arrow([[213,408],[300,486],[787,486],[835,418]],P.blue); tag(498,486,'3. 继续直接沟通');
      arrow([[947,444],[947,606],[170,606],[170,451]],P.green,true); tag(724,606,'追问信息／给出答复',P.green,P.greenFill);
      document(654,378,'相关历史',P.purple); arrow([[720,379],[826,379]],P.purple,true);
      rect(886,534,280,39,P.purpleFill,'transparent'); text(1026,554,'售后指令 · 专属工具',20,P.purple);
      footer('接管的是当前对话的执行权；没有必须“回到接待 Agent 汇总”的步骤');
    } },
  { id:5,slug:'workflow',en:'GRAPH ORCHESTRATION',title:'工作流／图编排',
    idea:'Agent 在节点内自主工作，节点之间按图中的规则流转。',control:'图运行时推进',
    note:'本例用固定审核分支说明原理；图也可包含动态分派和并行分支。节点可以是完整 Agent 或普通程序，不能把所有图节点都称为 Agent。',refs:['graph','crew'],
    draw({rect,agent,arrow,text,tag,footer,c}) {
      rect(67,195,1146,71,P.purpleFill,'transparent'); text(640,230,'图运行时：节点 · 条件边 · 共享状态',24,P.purple);
      agent(185,394,'研究 Agent',{sub:'收集证据',w:218}); agent(465,394,'撰写 Agent',{sub:'产出草稿',w:218}); agent(745,394,'审核 Agent',{sub:'检查质量',w:218});
      arrow([[302,394],[346,394]]); arrow([[582,394],[626,394]]); arrow([[862,394],[908,394]]);
      c.diamond(917,343,110,103,{fill:P.orangeFill,stroke:P.orange}); text(972,394,'通过？',21,P.orange);
      arrow([[1036,394],[1110,394]],P.green); c.circle(1152,394,38,{fill:P.greenFill,stroke:P.green}); text(1152,394,'交付',22,P.green);
      tag(1080,359,'是',P.green,P.greenFill,17);
      arrow([[972,457],[972,570],[465,570],[465,462]],P.orange); tag(722,570,'否：把意见交回撰写节点',P.orange,P.orangeFill);
      text(640,649,'这条反馈路径由流程定义；每个节点内部仍可运行自己的 Loop。',22);
      footer('示例：研究 → 撰写 → 审核；分支、汇合与结束条件由工作流显式表达');
    } },
  { id:6,slug:'group-chat',en:'SELECTOR GROUP CHAT',title:'群聊／轮流讨论',
    idea:'主持者每次选一位行动，回复进入公共讨论，再选下一位。',control:'统一选择下一位',
    note:'展示 AutoGen 风格的轮流广播。被选中的成员也能写代码和执行工具；等待是团队发言调度，不代表成员没有能力。下一位不必遵循固定顺序。',refs:['chat'],
    draw({box,agent,rect,arrow,text,tag,footer}) {
      box(640,226,268,80,'主持者／选择器','规则或模型选下一位',P.purple,P.purpleFill);
      agent(200,400,'分析员 A',{sub:'此刻被选中',w:236});
      agent(1080,400,'评审者 C',{sub:'接收公共讨论',color:P.gray,fill:P.grayFill,active:false,w:236});
      agent(640,604,'开发者 B',{sub:'接收公共讨论',color:P.gray,fill:P.grayFill,active:false,w:236});
      rect(445,340,390,135,P.greenFill,P.green); text(640,372,'公共消息流',25,P.green);
      rect(467,399,346,52,P.white,'transparent'); text(640,425,'A：分析与工具执行结果…',20);
      arrow([[497,226],[200,226],[200,332]],P.blue); tag(323,227,'1. 选中 A');
      arrow([[326,378],[436,378]],P.blue); tag(380,342,'2. 回复',P.blue,P.blueFill,17);
      arrow([[836,418],[954,418]],P.green,true); tag(895,458,'3. 广播',P.green,P.greenFill,17);
      arrow([[640,483],[640,536]],P.green,true); arrow([[436,433],[326,433]],P.green,true);
      arrow([[714,332],[714,274]],P.purple); tag(937,288,'4. 未结束，再选下一位',P.purple,P.purpleFill);
      footer('此刻只有 A 被选中，B／C 等候；下一次可以选 B、C，也可以按规则继续选 A');
    } },
  { id:7,slug:'external-runtime',en:'CROSS-HARNESS DELEGATION',title:'把外部 Agent 接为后端',
    idea:'统一委派接口，把任务交给另一套完整的 Agent 运行时。',control:'接入维度 · 可组合',
    note:'这是接入扩展方式，可叠加在委派或团队协作上。图中只选一个后端；对方保留自己的模型、工具与权限实现。独立进程不等于独立文件系统。',refs:['provider','acp'],
    draw({rect,agent,arrow,box,text,tag,footer}) {
      rect(65,205,333,375,P.faint,P.line,{strokeStyle:'dashed'}); rect(852,205,361,375,P.faint,P.line,{strokeStyle:'dashed'});
      text(230,238,'主 Agent 运行时',24); text(1031,238,'外部 Agent 运行时',24);
      agent(230,354,'主 Agent',{sub:'提出子任务',w:240}); tag(230,502,'自己的模型与工具',P.blue,P.blueFill);
      box(623,357,236,140,'Provider 适配器','SDK / ACP / 子进程');
      arrow([[360,323],[496,323]]); tag(431,289,'任务',P.blue,P.blueFill,17);
      arrow([[748,323],[874,323]]); tag(810,289,'委派',P.blue,P.blueFill,17);
      agent(1033,334,'Codex',{sub:'本例选中的后端',color:P.green,fill:P.greenFill,w:292});
      rect(886,427,294,54,P.white,P.line); text(1033,454,'其他选择：Claude Code',21,P.muted);
      rect(886,498,294,54,P.white,P.line); text(1033,525,'其他选择：ACP Agent',21,P.muted);
      arrow([[877,372],[750,372]],P.green,true);
      arrow([[570,435],[570,480],[330,480],[330,422]],P.green,true); tag(455,480,'最终结果／错误',P.green,P.greenFill);
      tag(1033,625,'各后端保留原有运行机制',P.purple,P.purpleFill);
      footer('图示只选择一个后端；这是一种接入方式，可与前面的协作模式组合');
    } },
];
// 独立图源便于逐张编辑；HTML 内嵌 SVG，可离线阅读。
for(const figure of figures) {
  const d=drawing(figure); figure.draw(d);
  const base=`${String(figure.id).padStart(2,'0')}-${figure.slug}`;
  await d.c.save(fileURLToPath(new URL(`${base}.excalidraw`,output)));
  figure.base=base; figure.count=d.c.count; figure.svg=await readFile(new URL(`${base}.svg`,output),'utf8');
  figure.sources=figure.refs.map(key=>sources[key]);
}
await writeFile(new URL('index.html',output),gallery(figures),'utf8');
await writeFile(new URL('manifest.json',output),JSON.stringify(figures.map(({id,title,base,count,sources:refs})=>({id,title,base,elements:count,sources:refs})),null,2)+'\n');
console.error(`完成 ${figures.length} 张图，共 ${figures.reduce((sum,f)=>sum+f.count,0)} 个可编辑元素。`);
