/**
 * 长期记忆 v1 原理图：用提炼流水线、分层文件和跨会话读取回路呈现当前实现。
 * 本文件是图源，只生成同名 SVG / PNG / Excalidraw；不读取用户历史、记忆或凭证。
 * 图中对话片段仅为示例，两个阶段可分块请求；图表不代表每任务固定两次模型调用。
 */
import { canvas } from '/Users/tbsg/.codex/skills/jemicy-zjm-excalidraw-diagram/render/freedraw.mjs';

const P = {
  ink: '#273B50', muted: '#758498', line: '#DCE5ED', faint: '#F6F8FB',
  blue: '#447DAD', blueFill: '#EAF3FC', blueLine: '#B5D0E7',
  violet: '#8060A6', violetFill: '#F3EEFA', violetLine: '#D5C5E6',
  green: '#2E8870', greenFill: '#EDF8F2', greenLine: '#B5D9C9',
};
const c = canvas({ background: '#FFFFFF', roughness: 0, strokeWidth: 1.5,
  font: 'normal', fontSize: 22, stroke: P.line });

// 部件用局部坐标绘制并整体打组；文字按实际测宽校验，避免导出后被容器挤压。
function label(x, y, text, size = 22, color = P.ink) {
  c.text(x + c.textWidth(text, size) / 2, y, text, { fontSize: size, color });
}
function center(x, y, text, width, size = 22, color = P.ink) {
  if (Math.max(...text.split('\n').map(line => c.textWidth(line, size))) > width)
    throw new Error(`文字超出预留宽度：${text}`);
  c.text(x, y, text, { fontSize: size, color });
}
function box(w, h, fill = '#FFFFFF', stroke = P.line) {
  c.rect(0, 0, w, h, { fill, stroke, round: true });
}
function arrow(points, color = P.blue, dashed = false, both = false) {
  c.arrow(points, { stroke: color, strokeWidth: 2.5, head: 'triangle',
    tail: both ? 'triangle' : null, strokeStyle: dashed ? 'dashed' : 'solid' });
}
function section(number, title) {
  c.circle(15, 0, 15, { fill: P.faint, stroke: 'transparent' });
  c.text(15, 0, number, { fontSize: 17, color: P.muted });
  label(43, 0, title, 26);
}
function bars(width, color, count = 3) {
  for (let i = 0; i < count; i++)
    c.rect(0, i * 13, width - (i % 3) * 19, 5,
      { fill: color, stroke: 'transparent', round: true });
}
function document(color) {
  c.path('M 0 0 L 22 0 L 32 10 L 32 40 L 0 40 Z M 22 0 L 22 10 L 32 10',
    { stroke: color, strokeWidth: 1.8 });
  c.line([[7, 20], [25, 20]], { stroke: color });
  c.line([[7, 29], [22, 29]], { stroke: color });
}
function tick(color = P.green) {
  c.path('M 0 7 L 7 14 L 20 0', { stroke: color, strokeWidth: 3 });
}
function chip(width, text, fill, color) {
  box(width, 32, fill, 'transparent');
  center(width / 2, 16, text, width - 10, 17, color);
}

// 单画布三层：后台形成知识 → 本地分层保存 → 前台只读概览、按需找细节。
c.rect(0, 0, 1480, 1290, { fill: '#FFFFFF', stroke: 'transparent' });
label(65, 47, 'MYAGENT  /  LONG-TERM MEMORY', 16, P.muted);
label(65, 106, '把对话中的经验，带到下一次任务', 40);
label(65, 154, '后台积累知识，前台按需取用', 23, P.muted);
c.place(65, 209, () => section('1', '后台整理'));
label(877, 209, '显式开启 · 空闲 ≥30 分钟 · 前台优先', 20, P.muted);

// 多张聊天卡片代表不同会话；提炼读取已有事实，不替换原始历史。
c.rect(84, 263, 236, 190, { fill: '#EDF1F6', stroke: 'transparent', round: true });
c.rect(76, 255, 236, 190, { fill: '#F7F9FB', stroke: P.line, round: true });
c.place(68, 247, () => {
  box(236, 190);
  label(18, 30, '会话 A、B…', 24);
  c.rect(19, 59, 197, 48, { fill: P.blueFill, stroke: 'transparent', round: true });
  center(117, 83, '“我喜欢先看结论”', 187, 20, P.blue);
  c.rect(19, 119, 197, 48, { fill: P.faint, stroke: 'transparent', round: true });
  center(117, 143, '对话 + 工具记录', 185, 20, P.muted);
});
center(186, 480, '原始历史仍保留', 265, 21, P.muted);

// 两个无工具模型阶段；用提取卡片和重叠条目来区分“提炼”与“合并”。
c.place(390, 247, () => {
  box(216, 190, P.blueFill, P.blueLine);
  center(108, 30, '单会话提炼', 200, 25, P.blue);
  c.poly([[56, 62], [158, 62], [123, 102], [123, 119], [93, 132], [93, 102]],
    { fill: '#D4E6F6', stroke: P.blue, strokeWidth: 1.6 });
  c.place(101, 140, () => tick(P.blue));
  center(108, 168, '留下可复用信息', 202, 20, P.blue);
});
c.place(685, 247, () => {
  box(238, 190, P.violetFill, P.violetLine);
  center(119, 30, '跨会话整理', 224, 25, P.violet);
  c.rect(48, 66, 89, 63, { fill: '#E5D9F2', stroke: P.violetLine, round: true });
  c.place(61, 81, () => bars(62, '#B9A3D3', 3));
  c.rect(102, 88, 87, 62, { fill: '#FFFFFF', stroke: P.violet, round: true });
  c.place(116, 103, () => bars(57, P.violetLine, 3));
  center(119, 169, '合并 · 更新 · 待核实', 222, 19, P.violet);
});
c.place(1012, 247, () => {
  box(324, 190, P.greenFill, P.greenLine);
  c.path('M 135 25 L 164 15 L 193 25 L 193 55 Q 193 78 164 93 Q 135 78 135 55 Z',
    { fill: '#DAEDE3', stroke: P.green, strokeWidth: 1.8 });
  c.place(153, 45, () => tick());
  center(162, 120, '版本与来源校验', 298, 26, P.green);
  center(162, 158, '有效才发布', 295, 22, P.green);
});
arrow([[320, 338], [390, 338]]);
arrow([[606, 338], [685, 338]], P.violet);
arrow([[923, 338], [1012, 338]], P.green);
center(650, 480, '两阶段均为无工具模型请求', 510, 20, P.muted);

// 记忆库是全图中心。已有正文回到第二阶段参与合并，发布不会跳过来源/版本复核。
c.place(65, 572, () => section('2', '分层保存'));
arrow([[640, 583], [640, 532], [804, 532], [804, 437]], P.violet, true);
center(728, 555, '已有相关记忆', 268, 19, P.violet);
arrow([[1174, 437], [1174, 583]], P.green);
center(1280, 515, '校验后发布', 200, 20, P.green);
c.place(380, 583, () => {
  box(965, 253, '#FAFBFD', '#CCD9E5');
  label(25, 30, '本地长期记忆库', 26);
  label(674, 30, '全局保存 · 标注项目', 21, P.muted);
});

// 三种文件用不同大小/密度表示正文、轻量导航与证据；SQLite 只管理状态和可重建索引。
c.place(405, 641, () => {
  box(288, 135, '#FFFFFF', P.blueLine);
  c.place(18, 20, () => document(P.blue));
  label(66, 35, '记忆正文', 26);
  label(66, 66, 'MEMORY.md', 20, P.muted);
  c.place(18, 94, () => chip(74, '偏好', P.blueFill, P.blue));
  c.place(107, 94, () => chip(74, '项目', P.violetFill, P.violet));
  c.place(196, 94, () => chip(74, '经验', P.greenFill, P.green));
});
c.place(742, 641, () => {
  box(263, 135, '#FFFFFF', P.blueLine);
  label(19, 28, '精简概览', 25);
  c.place(19, 55, () => bars(148, P.blueLine, 3));
  center(131, 114, '偏好 + 当前项目 + 导航', 245, 18, P.muted);
});
arrow([[693, 706], [742, 706]], P.blue);
c.place(1036, 641, () => {
  box(285, 135, '#FFFFFF', P.greenLine);
  center(142, 29, '提炼记录 + 来源', 266, 24);
  c.place(18, 58, () => chip(105, '会话 A', P.greenFill, P.green));
  c.place(161, 58, () => chip(105, '会话 B', P.greenFill, P.green));
  c.line([[125, 74], [159, 74]], { stroke: P.greenLine, strokeWidth: 2 });
  center(142, 113, '原文可追溯', 257, 20, P.green);
});
center(862, 808, 'SQLite：版本 · 来源 · 整理任务 · 可重建索引', 917, 21, P.muted);

// 用户明确的记忆修改经过同一服务发布；人工修改不是交给后台模型任意覆盖。
c.place(68, 662, () => {
  box(236, 136, P.violetFill, P.violetLine);
  c.path('M 28 51 L 54 25 L 63 34 L 37 60 L 24 64 Z M 49 30 L 58 39',
    { stroke: P.violet, fill: '#E4D9F0', strokeWidth: 1.8 });
  label(79, 43, '明确更新', 24, P.violet);
  center(118, 90, '记住 / 更正 / 忘记', 215, 20, P.violet);
  center(118, 118, 'update_memory', 216, 17, P.violet);
});
arrow([[304, 720], [380, 720]], P.violet);

// 概览蓝线只在 Run 首次准备时加载；后续请求复用快照，撤销在准备边界生效。
c.place(65, 901, () => section('3', '新对话复用'));
arrow([[872, 836], [872, 959]], P.blue);
c.rect(700, 861, 344, 70, { fill: '#FFFFFF', stroke: 'transparent' });
center(872, 881, '每 Run 取一次概览', 330, 24, P.blue);
center(872, 915, '后续步骤 / 压缩复用 · 可撤销', 334, 19, P.muted);

// 当前任务只收到有界概览，未读的正文和证据留在本地库中。
c.place(70, 1008, () => {
  box(266, 112);
  center(133, 30, '新的对话', 244, 24);
  center(133, 78, '“按之前的约定\n继续帮我处理”', 244, 21, P.muted);
});
arrow([[336, 1064], [632, 1064]], P.blue);
center(476, 1033, '当前任务', 220, 21, P.blue);
c.place(632, 959, () => {
  box(373, 241, '#FFFFFF', P.blueLine);
  center(186, 28, '每次请求模型的上下文', 348, 24);
  c.rect(18, 61, 337, 55, { fill: P.faint, stroke: 'transparent', round: true });
  center(186, 88, '规则 · 工具 · 当前对话历史', 319, 20, P.muted);
  c.rect(18, 131, 337, 99, { fill: P.blueFill, stroke: P.blueLine, round: true });
  center(186, 156, '长期记忆概览', 310, 23, P.blue);
  center(186, 184, '≤2,500 估算 token', 310, 19, P.blue);
  center(186, 210, '且 ≤ 可用输入预算的 10%', 310, 18, P.blue);
});
arrow([[1005, 1064], [1152, 1064]], P.blue);
center(1078, 1035, '本次请求', 140, 18, P.blue);
c.place(1152, 997, () => {
  box(193, 148, '#2E465E', 'transparent');
  center(96, 48, 'LLM', 170, 34, '#FFFFFF');
  center(96, 104, '模型', 170, 26, '#E1ECF5');
});

// 绿色双向链路表示模型自主查阅：请求和结果成对，回传所需片段进入下一次模型请求。
c.place(1124, 881, () => {
  box(248, 80, P.greenFill, P.greenLine);
  center(124, 26, '按需搜索 / 查阅', 230, 23, P.green);
  center(124, 59, '片段进入下一次请求', 230, 20, P.green);
});
arrow([[1248, 881], [1248, 836]], P.green, false, true);
arrow([[1248, 997], [1248, 961]], P.green, false, true);
center(1235, 1173, 'search_memories / read_memory', 364, 18, P.green);

// 三个短约束收尾，避免把任务队列、额度与迁移细节堆进主画面。
c.line([[65, 1230], [1415, 1230]], { stroke: P.line, strokeWidth: 1 });
c.place(76, 1257, () => tick(P.violet));
label(108, 1264, '人工修订优先', 22, P.violet);
c.place(518, 1257, () => tick(P.green));
label(550, 1264, '遗忘后排除旧来源', 22, P.green);
c.place(991, 1257, () => tick(P.muted));
label(1023, 1264, '删除会话，撤销其贡献', 22, P.muted);

await c.save(new URL('./long-term-memory.excalidraw', import.meta.url).pathname);
console.log(`长期记忆原理图：${c.count} 个可编辑元素`);
