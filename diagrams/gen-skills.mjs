/**
 * Skill v1 原理图：以目录卡片、完整说明和只读资源展示渐进加载与受控执行。
 * 本文件是唯一图源，仅生成同名 SVG / PNG / Excalidraw，不读取用户技能或运行数据。
 * 关键语义：显式选择先加载，自主选择通过普通工具；正文单独注入，脚本仍经过原执行系统。
 */
import { canvas } from '/Users/tbsg/.codex/skills/jemicy-zjm-excalidraw-diagram/render/freedraw.mjs';

const P = {
  ink: '#273B50', muted: '#738398', line: '#DAE3EC', faint: '#F5F8FB',
  blue: '#397BAE', blueFill: '#EAF3FC', blueLine: '#AFCBE3',
  violet: '#7958A2', violetFill: '#F3EEFA', violetLine: '#CDBBE3',
  green: '#2C876D', greenFill: '#EEF8F3', greenLine: '#AFD4C4',
  amber: '#A57126', amberFill: '#FFF6E8', amberLine: '#E9D1AA',
};
const c = canvas({ background: '#FFFFFF', font: 'normal', fontSize: 22,
  roughness: 0, strokeWidth: 1.5, stroke: P.line });

// 局部部件统一打组；文字测宽与导出同口径，避免缩放后溢出。
function label(x, y, text, size = 22, color = P.ink) {
  c.text(x + c.textWidth(text, size) / 2, y, text, { fontSize: size, color });
}
function center(x, y, text, width, size = 22, color = P.ink) {
  if (Math.max(...text.split('\n').map(line => c.textWidth(line, size))) > width)
    throw new Error(`文字超出容器：${text}`);
  c.text(x, y, text, { fontSize: size, color });
}
function box(w, h, fill = '#FFFFFF', stroke = P.line) {
  c.rect(0, 0, w, h, { fill, stroke, round: true });
}
function arrow(points, color = P.blue, dashed = false) {
  c.arrow(points, { stroke: color, strokeWidth: 2.5,
    head: 'triangle', strokeStyle: dashed ? 'dashed' : 'solid' });
}
function folder(color) {
  c.path('M 0 7 L 0 1 L 15 1 L 20 7 L 36 7 L 36 31 L 0 31 Z',
    { fill: '#FFFFFF', stroke: color, strokeWidth: 1.8 });
}
function file(color) {
  c.path('M 0 0 L 23 0 L 34 11 L 34 44 L 0 44 Z M 23 0 L 23 11 L 34 11',
    { fill: '#FFFFFF', stroke: color, strokeWidth: 1.8 });
  c.line([[8, 23], [26, 23]], { stroke: color });
  c.line([[8, 32], [23, 32]], { stroke: color });
}
function chip(w, text, fill, color) {
  box(w, 30, fill, 'transparent');
  center(w / 2, 15, text, w - 12, 17, color);
}

// 三类来源在 Run 外；浅色背景包围本轮目录、模型请求与现有工具，突出唯一循环。
c.rect(0, 0, 1530, 1190, { fill: '#FFFFFF', stroke: 'transparent' });
label(65, 48, 'MYAGENT  /  SKILL V1', 17, P.muted);
label(65, 108, '按需获得方法，通过工具完成任务', 40);
c.rect(375, 184, 1000, 908, { fill: '#FAFCFE', stroke: P.line,
  round: true, strokeStyle: 'dashed' });
c.rect(405, 167, 295, 34, { fill: '#FFFFFF', stroke: 'transparent' });
label(417, 184, '一个 Run · 沿用原 Agent Loop', 21, P.blue);

// 来源只登记不搬动文件；同名技能使用不同来源 ID。
c.place(65, 245, () => {
  box(265, 230);
  label(20, 29, '本地技能源', 26);
  const rows = [ ['用户级', 'MyAgent/Skills'], ['项目级', '.myagent/skills'], ['额外来源', '手动接入的目录'] ];
  rows.forEach(([title, path], i) => {
    c.place(20, 64 + i * 54, () => folder(P.blue));
    label(70, 70 + i * 54, title, 22);
    label(70, 93 + i * 54, path, 17, P.muted);
  });
});
arrow([[330, 340], [400, 340]]);
center(365, 308, '发现', 66, 19, P.blue);
c.place(400, 245, () => {
  box(300, 202, P.blueFill, P.blueLine);
  label(20, 28, '先给技能目录', 26, P.blue);
  for (let i = 0; i < 3; i++) {
    c.rect(20, 57 + i * 31, 258, 25,
      { fill: '#FFFFFF', stroke: i === 0 ? P.blueLine : 'transparent', round: true });
    c.circle(34, 69 + i * 31, 4, { fill: P.blue, stroke: 'transparent' });
    label(49, 69 + i * 31, ['report', 'review', '…'][i], 18, P.blue);
    c.rect(144, 67 + i * 31, 115 - i * 20, 5,
      { fill: '#D8E6F3', stroke: 'transparent', round: true });
  }
  center(150, 174, '名称 · 用途 · ID', 273, 22, P.blue);
});
center(550, 478, '更多：search_skills', 300, 21, P.muted);
arrow([[700, 322], [820, 322]]);

// 模型每次接收目录与已激活正文；未激活正文不预先占满上下文。
c.place(820, 230, () => {
  box(510, 245, '#FFFFFF', P.blueLine);
  label(21, 31, '每次模型请求的上下文', 28);
  const rows = [
    ['技能目录元信息', P.blueFill, P.blue, 69],
    ['已加载技能的完整说明', P.violetFill, P.violet, 126],
    ['规则 · 工具定义 · 记忆 · 对话', P.faint, P.muted, 183],
  ];
  for (const [text, fill, color, y] of rows) {
    c.rect(19, y, 472, 44, { fill, stroke: 'transparent', round: true });
    center(255, y + 22, text, 448, 23, color);
  }
});
arrow([[1180, 475], [1180, 550]]);
c.place(1030, 550, () => {
  box(300, 170, P.blueFill, P.blueLine);
  // 芯片轮廓代表模型，避免把计划或 Skill 画成框架内的第二个决策器。
  c.rect(24, 27, 40, 40, { fill: '#FFFFFF', stroke: P.blue, round: true });
  for (let i = 0; i < 3; i++) {
    c.line([[31 + 12 * i, 20], [31 + 12 * i, 27]], { stroke: P.blue });
    c.line([[31 + 12 * i, 67], [31 + 12 * i, 74]], { stroke: P.blue });
  }
  label(91, 49, '模型', 33, P.blue);
  center(150, 106, '自主决定下一步', 273, 25, P.blue);
  center(150, 143, '回答 / 加载技能 / 调工具', 275, 20, P.muted);
});

// 两条选择路径汇入同一激活服务：显式选择首请求前加载，自主选择使用普通 load_skill。
c.place(65, 585, () => {
  box(265, 118, P.violetFill, P.violetLine);
  center(132, 35, '用户点选 / $技能', 242, 25, P.violet);
  center(132, 80, '首个请求前加载', 242, 21, P.violet);
});
arrow([[330, 630], [455, 630]], P.violet);
c.place(455, 560, () => {
  box(330, 160, '#FFFFFF', P.violetLine);
  label(21, 31, '加载完整说明', 26, P.violet);
  c.place(23, 63, () => file(P.violet));
  label(77, 84, 'SKILL.md', 26, P.violet);
  center(165, 132, '校验版本 · 激活技能', 300, 21, P.muted);
});
arrow([[1030, 625], [785, 625]], P.violet);
center(905, 597, 'load_skill', 220, 24, P.violet);
arrow([[760, 560], [760, 378], [820, 378]], P.violet);
label(779, 513, '单独注入正文', 20, P.violet);

// 包快照与激活引用持久保存；只读运行副本可重建，不读取新源文件替换当前 Run。
arrow([[555, 720], [555, 780], [280, 780], [280, 865]], P.violet);
center(425, 754, '固定本轮包版本', 295, 21, P.violet);
c.place(65, 865, () => {
  box(440, 208, P.violetFill, P.violetLine);
  label(21, 30, '技能包快照', 27, P.violet);
  c.place(349, 14, () => chip(72, '只读', '#FFFFFF', P.violet));
  c.place(28, 77, () => file(P.violetLine));
  c.place(37, 69, () => file(P.violet));
  label(98, 82, 'SKILL.md', 24, P.violet);
  label(98, 118, 'references / scripts / assets', 20, P.violet);
  center(220, 178, '文件快照 + SQLite 激活记录', 405, 21, P.muted);
});

// 第三层资料与真实执行复用现有工具；只读包访问不意味着命令、联网或写文件免审批。
arrow([[1180, 720], [1180, 815]], P.green);
center(1282, 769, '按需使用', 169, 21, P.green);
c.place(595, 815, () => {
  box(735, 258, '#FFFFFF', P.greenLine);
  label(22, 32, '按需读资源、执行动作', 27, P.green);
});
c.place(615, 890, () => {
  box(270, 155, P.greenFill, 'transparent');
  center(135, 34, '查阅参考资料', 246, 25, P.green);
  center(135, 80, 'read_skill_resource', 246, 21, P.green);
  center(135, 123, '分页读取所需片段', 246, 22, P.muted);
});
c.place(915, 890, () => {
  box(395, 155, P.amberFill, 'transparent');
  center(197, 32, 'exec_command 等原有工具', 371, 23, P.amber);
  center(197, 78, '命令 + 资源检查 → 必要审批', 371, 21, P.amber);
  center(197, 122, 'OS 沙箱 → 项目产物', 371, 24, P.amber);
});
arrow([[505, 976], [595, 976]], P.violet);
center(549, 943, '只读包', 85, 20, P.violet);

// 返回上方上下文而非直接跳入模型：工具观察经过原持久化/容量治理，成为下一次输入。
arrow([[1330, 936], [1435, 936], [1435, 350], [1330, 350]], P.green);
c.text(1474, 639, '所需片段与执行结果 → 下一次请求',
  { fontSize: 22, color: P.green, angle: -Math.PI / 2 });

c.line([[65, 1110], [1435, 1110]], { stroke: P.line });
c.place(75, 1130, () => chip(106, '本轮 Run', P.violetFill, P.violet));
label(201, 1145, '完整说明持续生效，压缩不替换', 23, P.violet);
arrow([[870, 1145], [990, 1145]], P.muted, true);
label(1030, 1145, '下一轮重新选择', 24, P.muted);

await c.save(new URL('./skills.excalidraw', import.meta.url).pathname);
console.error(`Skill 原理图：${c.count} 个可编辑元素`);
