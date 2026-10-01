/**
 * 大工具结果原理插画：用同色头尾、保留的原文件和分页回路展示当前实现。
 * 本文件是唯一图源，只生成 tool-result-handling 的 SVG / PNG / Excalidraw；不读取运行数据。
 * #R17、退出码及片段均为示意；保存受额度限制，模型预览与采集完整性分别标记。
 */
import { canvas } from '/Users/tbsg/.codex/skills/jemicy-zjm-excalidraw-diagram/render/freedraw.mjs';

const C = {
  ink: '#243548', muted: '#758394', border: '#DAE3EC', faint: '#F6F8FB',
  blue: '#447CAB', blueFill: '#EAF3FC', blueLine: '#B7D0E8',
  purple: '#8762AD', purpleFill: '#F3ECFA', purpleLine: '#D2BFE4',
  green: '#2C866E', greenFill: '#EBF7F0', greenLine: '#B4D8C9',
};
const c = canvas({ background: '#FFFFFF', stroke: C.border, roughness: 0,
  strokeWidth: 1.5, font: 'normal', fontSize: 20 });

// 文本根据真实测宽定位；复用局部部件并打组，便于在 Excalidraw 中继续编辑。
function left(x, y, value, size = 20, color = C.ink) {
  c.text(x + c.textWidth(value, size) / 2, y, value, { fontSize: size, color });
}
function centered(x, y, value, width, size = 20, color = C.ink) {
  if (Math.max(...value.split('\n').map((line) => c.textWidth(line, size))) > width) throw new Error(`文字超出预留宽度：${value}`);
  c.text(x, y, value, { fontSize: size, color });
}
function box(w, h, fill = '#FFFFFF', stroke = C.border) {
  c.rect(0, 0, w, h, { fill, stroke, round: true });
}
function arrow(points, color, dashed = false) {
  c.arrow(points, { stroke: color, strokeWidth: 2.4,
    strokeStyle: dashed ? 'dashed' : 'solid', head: 'triangle' });
}
function heading(n, title) {
  c.circle(14, 0, 14, { fill: '#EFF3F7', stroke: 'transparent' });
  c.text(14, 0, n, { fontSize: 16, color: C.muted });
  left(40, 0, title, 25);
}
function lines(w, color, count = 3) {
  for (let i = 0; i < count; i++)
    c.rect(0, i * 14, w - (i % 3) * 18, 5, { fill: color, stroke: 'transparent', round: true });
}
function segment(label, w, h, fill, color, lineColor) {
  box(w, h, fill, 'transparent');
  left(16, h / 2, label, 20, color);
  c.place(w - 112, h / 2 - 11, () => lines(92, lineColor, 2));
}
function fileIcon(color) {
  c.path('M 0 0 L 20 0 L 29 9 L 29 35 L 0 35 Z M 20 0 L 20 9 L 29 9', { stroke: color, strokeWidth: 1.8 });
  c.line([[7, 18], [22, 18]], { stroke: color });
  c.line([[7, 25], [19, 25]], { stroke: color });
}

// 三个主对象：已落盘的大结果、模型预览、模型。长文件明显大于预览的正文面积。
c.rect(0, 0, 1390, 984, { fill: '#FFFFFF', stroke: 'transparent' });
left(64, 47, 'MYAGENT  /  TOOL OUTPUT', 15, C.muted);
left(64, 100, '大结果留在本地，模型先看头尾', 38);
left(64, 150, '以长日志为例 · 需要细节时，再按引用补读', 21, C.muted);
c.place(64, 209, () => heading('1', '保存工具结果'));
c.place(548, 209, () => heading('2', '生成头尾预览'));
c.place(1145, 209, () => heading('3', '交给模型'));

// 左侧叠页意味着持久保存；灰色中间段仍然存在，绿色条是稍后分页查回的原文。
c.rect(78, 259, 331, 389, { fill: '#E8EDF3', stroke: 'transparent', round: true });
c.rect(71, 252, 331, 389, { fill: '#F3F6F9', stroke: C.border, round: true });
c.place(64, 245, () => box(331, 389));
c.place(83, 264, () => fileIcon(C.muted));
left(129, 283, '已采集原文', 22);
c.place(288, 266, () => {
  box(87, 34, C.faint, 'transparent');
  centered(43, 17, '#R17', 80, 19, C.muted);
});
c.place(83, 316, () => segment('开头', 292, 59, C.blueFill, C.blue, C.blueLine));
c.place(83, 388, () => {
  box(292, 147, C.faint, 'transparent');
  c.place(17, 17, () => lines(256, '#D8DFE7', 3));
  c.rect(12, 67, 268, 36, { fill: C.greenFill, stroke: C.greenLine, round: true });
  left(25, 85, '某一段细节', 18, C.green);
  c.place(176, 79, () => lines(81, C.greenLine, 2));
  c.place(17, 119, () => lines(233, '#D8DFE7', 1));
});
c.place(83, 548, () => segment('结尾 / 报错', 292, 59, C.purpleFill, C.purple, C.purpleLine));

// 预览保留同色头尾，虚线间隙表示省略。执行状态独立于可缩减正文。
c.rect(553, 250, 450, 385, { fill: '#DEE7F1', stroke: 'transparent', opacity: 30, round: true });
c.place(548, 245, () => box(450, 385, '#FFFFFF', '#C7D6E4'));
c.place(568, 264, () => {
  box(410, 44, '#F2F5F8', 'transparent');
  centered(205, 22, '执行状态：失败   ·   退出码：1', 380, 19, '#506477');
});
c.place(568, 326, () => segment('保留开头', 410, 66, C.blueFill, C.blue, C.blueLine));
c.rect(568, 406, 410, 66, { fill: '#FBFCFD', stroke: '#C7D1DC', strokeStyle: 'dashed', round: true });
centered(773, 428, '··· 中间内容已省略 ···', 380, 21, C.muted);
centered(773, 454, '结果引用  #R17', 380, 17, C.green);
c.place(568, 486, () => segment('保留结尾 / 报错', 410, 66, C.purpleFill, C.purple, C.purpleLine));
centered(773, 592, '≤ 8,000 字符，含状态、说明与引用', 415, 19, C.muted);

// 两色箭头强调拷贝头尾；原文件中间段并没有被删除，也不是先让模型摘要整份结果。
arrow([[395, 346], [468, 346], [468, 359], [568, 359]], C.blue);
arrow([[395, 577], [482, 577], [482, 519], [568, 519]], C.purple);

// 右侧模型与当次请求的主连线；原文片段稍后沿较低入口进入下一次请求。
c.place(1153, 353, () => {
  box(145, 115, '#2F455B', 'transparent');
  centered(72, 52, 'LLM', 130, 34, '#FFFFFF');
  centered(72, 90, '模型', 125, 18, '#DBE7F2');
});
arrow([[998, 390], [1153, 390]], C.blue);
centered(1073, 362, '本次请求', 140, 18, C.blue);
centered(1226, 519, '先依据预览继续', 244, 21, C.ink);

// 绿色虚线是“请求补读”；绿色实线是“返回片段”。两条路径分层，避免交叉。
arrow([[1226, 544], [1226, 802], [1020, 802]], C.green, true);
centered(1317, 623, '需要\n更多细节', 136, 20, C.green);
c.place(750, 758, () => {
  box(270, 88, C.greenFill, C.greenLine);
  centered(135, 28, '按引用分页补读', 246, 23, C.green);
  centered(135, 61, 'read_tool_result · #R17', 250, 17, C.green);
});
arrow([[750, 802], [229, 802], [229, 641]], C.green, true);
centered(470, 835, '用引用找到已保存的结果', 455, 19, C.green);

// 与文件中的绿色细节条保持同色、同引用。只回传所需片段，原文件不被替换。
c.place(548, 667, () => {
  box(450, 64, '#FFFFFF', C.greenLine);
  c.place(18, 15, () => fileIcon(C.green));
  left(64, 32, '#R17  原文片段', 21, C.green);
  c.place(310, 19, () => lines(117, C.greenLine, 3));
});
arrow([[344, 643], [344, 699], [548, 699]], C.green);
arrow([[998, 699], [1085, 699], [1085, 435], [1153, 435]], C.green);
centered(1090, 733, '下一次请求', 170, 18, C.green);

// 仅保留影响读图结论的边界；更细的恢复、权限和序列化规则留在配套文档。
c.line([[64, 900], [1326, 900]], { stroke: C.border, strokeWidth: 1 });
left(64, 928, '保存额度：单结果 20 MiB / 单 Run 100 MiB', 18, C.muted);
left(790, 928, '命令即时日志预览：≤ 6,000 字符', 18, C.muted);
left(64, 961, '采集不完整会标注；再次缩短预览从已保存原文生成，不删除原文。', 18, C.muted);

await c.save(new URL('./tool-result-handling.excalidraw', import.meta.url).pathname);
console.log(`工具结果原理图：${c.count} 个可编辑元素`);
