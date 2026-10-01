/**
 * 上下文原理插画生成器：用原文卡片、摘要收拢、请求页和查阅回路展示当前实现。
 * 本文件是图源，只覆盖 context-management 的 SVG / Excalidraw / PNG，不读取产品数据。
 * 同编号卡片表示同一来源；摘要替换模型输入而不删除左侧原记录，查询结果只取一个片段。
 */
import { canvas } from '/Users/tbsg/.codex/skills/jemicy-zjm-excalidraw-diagram/render/freedraw.mjs';

const C = {
  ink: '#263544', muted: '#788798', line: '#E1E8EE', blue: '#5682B3',
  blueFill: '#EFF5FC', purple: '#8863B7', purpleFill: '#F1EBF9',
  green: '#368674', greenFill: '#EBF6F0', gold: '#AD8135', goldFill: '#FFF4DC',
};
const c = canvas({ background: '#FFFFFF', roughness: 0, strokeWidth: 1.5, font: 'normal', fontSize: 20 });

// 文字采用真实测宽后定位；不靠压小字号掩盖溢出，所有文字都可在源图继续编辑。
function left(x, y, value, size = 20, color = C.ink) {
  c.text(x + c.textWidth(value, size) / 2, y, value, { fontSize: size, color });
}
function label(value, width, size = 20, color = C.ink) {
  if (c.textWidth(value, size) > width - 20) throw new Error(`文字超宽：${value}`);
  c.text(width / 2, 0, value, { fontSize: size, color });
}
function chip(value, width, fill, color, dashed = false) {
  c.rect(0, -22, width, 44, { round: true, fill, stroke: dashed ? C.line : 'transparent', strokeStyle: dashed ? 'dashed' : 'solid' });
  label(value, width, 18, color);
}
function heading(number, title) {
  c.circle(14, 0, 14, { fill: '#EDF1F5', stroke: 'transparent' });
  c.text(14, 0, number, { fontSize: 15, color: C.muted });
  left(40, 0, title, 25);
}
function record(number, title, color, fill, selected = false) {
  c.rect(3, 4, 240, 54, { round: true, fill: '#DDE3EC', stroke: 'transparent', opacity: 30 });
  c.rect(0, 0, 240, 54, { round: true, fill, stroke: selected ? C.green : 'transparent', strokeWidth: selected ? 2.5 : 1 });
  c.rect(12, 12, 42, 30, { round: true, fill: '#FFFFFF', stroke: 'transparent', opacity: 80 });
  c.text(33, 27, number, { fontSize: 16, color });
  left(68, 27, title, 20, color);
}
function documentIcon(color) {
  c.path('M 0 0 L 23 0 L 33 10 L 33 39 L 0 39 Z M 23 0 L 23 10 L 33 10', { stroke: color, strokeWidth: 1.8 });
  c.line([[8, 19], [24, 19]], { stroke: color, strokeWidth: 1.8 });
  c.line([[8, 27], [21, 27]], { stroke: color, strokeWidth: 1.8 });
}
function arrow(points, color = C.blue, dashed = false, width = 2.2) {
  c.arrow(points, { stroke: color, strokeWidth: width, strokeStyle: dashed ? 'dashed' : 'solid', head: 'triangle' });
}

// 主画面只有三种对象：原文仓库、当次输入页、模型；颜色保留原文到输入的对应关系。
c.rect(0, 0, 1410, 987, { fill: '#FFFFFF', stroke: 'transparent' });
left(64, 48, 'MYAGENT  /  CONTEXT', 15, C.muted);
left(64, 98, '上下文怎样变小，细节怎样找回', 38);
c.place(64, 175, () => heading('1', '保存原文'));
c.place(510, 175, () => heading('2', '整理本次输入'));
c.place(1155, 175, () => heading('3', '交给模型'));

// 所有原文卡片一直留在仓库；#03 的绿色描边与下方返回片段对应。
c.rect(64, 215, 290, 523, { round: true, fill: '#F7F9FB', stroke: C.line });
const records = [
  ['01', '问答', C.purple, C.purpleFill],
  ['02', '问答', C.purple, C.purpleFill],
  ['03', '调用 + 结果', C.purple, C.purpleFill],
  ['04', '问答', C.purple, C.purpleFill],
  ['05', '问答', C.blue, C.blueFill],
  ['06', '调用 + 结果', C.blue, C.blueFill],
];
records.forEach(([number, title, color, fill], i) => c.place(88, 245 + i * 71, () => record(number, title, color, fill, number === '03')));
c.circle(119, 702, 9, { stroke: C.muted, fill: '#FFFFFF' });
c.line([[115, 702], [123, 702]], { stroke: C.muted, strokeWidth: 1.3 });
c.line([[119, 698], [119, 706]], { stroke: C.muted, strokeWidth: 1.3 });
left(139, 702, '新记录持续追加', 18, C.muted);

// 原文到摘要的收拢是画面的核心：四张卡片变成一张，左边四张卡片不消失。
c.line([[338, 245], [352, 245], [352, 512], [338, 512]], { stroke: C.purple, strokeWidth: 1.8 });
c.line([[352, 373], [378, 373]], { stroke: C.purple, strokeWidth: 2.4 });
c.poly([[378, 329], [446, 353], [446, 393], [378, 417]], { fill: C.purpleFill, stroke: '#D7C7ED', strokeWidth: 1 });
for (let i = 0; i < 4; i++) c.line([[386, 342 + i * 20], [437, 363 + i * 7]], { stroke: C.purple, opacity: 55, strokeWidth: 2 });

c.text(410, 300, '模型摘要', { fontSize: 21, color: C.purple });
c.rect(380, 450, 64, 7, { fill: '#E8E2F0', stroke: 'transparent', round: true });
c.rect(380, 450, 51, 7, { fill: C.purple, stroke: 'transparent', round: true });
c.text(412, 438, '80%', { fontSize: 16, color: C.purple });
c.text(412, 482, '接近容量', { fontSize: 17, color: C.muted });
// 近期原文直接选入，不经过摘要漏斗。

c.text(416, 624, '原样保留', { fontSize: 18, color: C.blue });

// 当次输入页：固定材料在上，历史摘要与近期原文分层，当前问题保持原文。
c.rect(515, 220, 520, 523, { round: true, fill: '#DFE6EF', stroke: 'transparent', opacity: 26 });
c.rect(510, 215, 520, 523, { round: true, fill: '#FFFFFF', stroke: '#C5D2E1', strokeWidth: 2 });
c.place(534, 266, () => chip('指令 / 项目规则', 194, '#F0F3F6', '#566779'));
c.place(740, 266, () => chip('工具', 92, '#F0F3F6', '#566779'));
c.place(844, 266, () => chip('记忆：空', 162, '#FAFBFC', '#9AA6B3', true));
c.rect(534, 330, 472, 84, { round: true, fill: C.purpleFill, stroke: '#E1D6EF' });
c.place(558, 352, () => documentIcon(C.purple));
left(612, 361, '一份摘要', 24, C.purple);
left(612, 389, '#01–04', 16, C.purple);
for (const [i, width] of [105, 88, 65].entries()) c.rect(870, 351 + i * 16, width, 5, { fill: '#C4AFE0', stroke: 'transparent', round: true });

c.rect(534, 438, 472, 112, { round: true, fill: C.blueFill, stroke: '#DDE7F3' });
left(554, 462, '近期原文', 19, C.blue);
for (const [i, title] of ['#05   问答', '#06   调用 + 结果'].entries()) {
  left(554, 492 + i * 29, title, 18, C.blue);
  c.line([[775, 492 + i * 29], [968, 492 + i * 29]], { stroke: '#C1D4E9', strokeWidth: 4 });
}
c.rect(534, 575, 472, 54, { round: true, fill: C.goldFill, stroke: 'transparent' });
left(557, 602, '当前问题', 23, C.gold);
c.line([[757, 602], [970, 602]], { stroke: '#E4CF9F', strokeWidth: 4 });
c.rect(534, 649, 472, 54, { round: true, fill: '#F0F5F8', stroke: 'transparent' });
left(557, 676, '本轮进度 / 工具结果', 21, '#586F84');
c.place(895, 676, () => chip('可摘要', 96, C.purpleFill, C.purple));
c.text(770, 722, '执行状态 · 必要续接', { fontSize: 16, color: C.muted });
// 箭头最后画，避免请求页的白底盖住汇入的箭头尖端。
arrow([[446, 373], [534, 373]], C.purple, false, 3);
arrow([[354, 599], [470, 599], [470, 496], [534, 496]], C.blue);

// 模型是主要请求的终点；查询支路沿底部，取回的小片段进入下一次输入。
arrow([[1030, 478], [1168, 478]], C.blue, false, 3);
c.text(1100, 451, '每次请求', { fontSize: 17, color: C.blue });
c.rect(1182, 423, 110, 110, { fill: '#2F4458', stroke: 'transparent', round: true });
c.text(1237, 478, 'LLM', { fontSize: 30, color: '#FFFFFF', font: 'code' });
c.text(1237, 564, '模型', { fontSize: 27, color: C.ink });
c.text(1237, 603, '回答 / 调工具', { fontSize: 19, color: C.muted });

arrow([[1237, 632], [1237, 871], [1181, 871]], C.green, true);
c.text(1320, 760, '需要细节？', { fontSize: 21, color: C.green });
c.rect(995, 826, 186, 90, { round: true, fill: C.greenFill, stroke: '#B6D9C9' });
c.circle(1030, 869, 12, { stroke: C.green, strokeWidth: 2.2 });
c.line([[1039, 878], [1049, 888]], { stroke: C.green, strokeWidth: 2.2 });
left(1062, 871, '查阅原文', 22, C.green);
arrow([[995, 871], [210, 871], [210, 738]], C.green, true);
c.text(616, 902, '按关键词 / 来源引用', { fontSize: 18, color: C.green });

// 回传的只是命中片段，不把整份历史重新装回。引用编号与原始卡片一致。
arrow([[354, 715], [410, 715], [410, 784], [1054, 784], [1054, 676], [1006, 676]], C.green);
c.place(501, 784, () => {
  c.rect(0, -26, 232, 52, { round: true, fill: '#FFFFFF', stroke: C.green, strokeWidth: 2 });
  c.place(15, -15, () => {
    c.rect(0, 0, 23, 29, { fill: C.greenFill, stroke: C.green, round: true });
    c.line([[6, 10], [17, 10]], { stroke: C.green, strokeWidth: 1.4 });
    c.line([[6, 18], [15, 18]], { stroke: C.green, strokeWidth: 1.4 });
  });
  left(53, 0, '#03 原文片段', 20, C.green);
});
c.text(878, 814, '进入下一次输入', { fontSize: 18, color: C.green });

// 容量/恢复/协议细节留给正文；图中只保留会改变读图结论的实际实现边界。
c.line([[64, 945], [1346, 945]], { stroke: C.line, strokeWidth: 1 });
left(64, 972, '原文按额度保存；压缩只改变模型输入。', 17, C.muted);
await c.save(new URL('./context-management.excalidraw', import.meta.url).pathname);
console.log(`原理插画：${c.count} 个可编辑元素`);
