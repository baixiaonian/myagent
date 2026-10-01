/**
 * 多 Agent 原理图的共用绘图部件，由 gen-multi-agent-patterns.mjs 调用。
 * 只生成讲解图，不访问会话或运行状态；颜色分别表达派发、返回、通信和等待。
 */
import { canvas } from '/Users/tbsg/.codex/skills/jemicy-zjm-excalidraw-diagram/render/freedraw.mjs';
export const P = {
  ink: '#243448', muted: '#738197', line: '#DBE3ED', faint: '#F5F7FB',
  blue: '#3976CD', blueFill: '#EDF4FF', green: '#21836B', greenFill: '#ECF8F2',
  purple: '#8362BB', purpleFill: '#F4EFFB', orange: '#BD792B', orangeFill: '#FFF5E7',
  gray: '#99A5B5', grayFill: '#F3F5F8', white: '#FFFFFF',
};
/** 每张图使用同一尺寸与图例；所有文字都保留为可编辑元素。 */
export function drawing(meta) {
  const c = canvas({ background: P.white, font: 'normal', fontSize: 21,
    roughness: 0, strokeWidth: 1.6, stroke: P.line });
  const text = (x, y, value, size = 22, color = P.ink) =>
    c.text(x, y, value, { fontSize: size, color });
  const left = (x, y, value, size = 22, color = P.ink) =>
    text(x + c.textWidth(value, size) / 2, y, value, size, color);
  const rect = (x, y, w, h, fill = P.white, stroke = P.line, options = {}) =>
    c.rect(x, y, w, h, { fill, stroke, round: true, ...options });
  const arrow = (points, color = P.blue, dashed = false) =>
    c.arrow(points, { stroke: color, strokeWidth: dashed ? 2 : 2.7,
      strokeStyle: dashed ? 'dashed' : 'solid', head: 'triangle', curve: true });
  const tag = (x, y, value, color = P.blue, fill = P.blueFill, size = 18) => {
    const w = c.textWidth(value, size) + 28;
    rect(x - w / 2, y - 17, w, 34, fill, 'transparent'); text(x, y, value, size, color);
  };
  const dot = (x, y, r, fill) => c.circle(x, y, r, { fill, stroke: 'transparent' });
  // 小闭环表示模型与工具反复交互，避免把 Agent 误画成一次 LLM 调用。
  const loop = (x, y, color = P.blue) => {
    arrow([[x - 23, y - 5], [x, y - 14], [x + 23, y - 5]], color);
    arrow([[x + 23, y + 6], [x, y + 14], [x - 23, y + 6]], color);
    dot(x - 23, y, 5, color); dot(x + 23, y, 5, color);
  };
  const bot = (x, y, color = P.blue, fill = P.blueFill) => c.place(x, y, () => {
    dot(0, 0, 32, fill); rect(-19, -14, 38, 29, P.white, color, { strokeWidth: 2 });
    c.line([[0, -14], [0, -23]], { stroke: color }); dot(0, -24, 3, color);
    dot(-7, -2, 3, color); dot(7, -2, 3, color);
    c.line([[-7, 8], [7, 8]], { stroke: color, strokeWidth: 2 });
  });
  const agent = (x, y, title, { color = P.blue, fill = P.blueFill,
    sub = '独立上下文', w = 220, active = true } = {}) => c.place(x, y, () => {
    rect(-w / 2 + 3, -55, w, 120, '#E9EEF5', 'transparent', { opacity: 45 });
    rect(-w / 2, -60, w, 120, P.white, active ? color : P.line, { strokeWidth: active ? 2 : 1.5 });
    bot(-w / 2 + 44, -15, color, fill);
    text(27, -29, title, 23, active ? P.ink : P.muted); text(27, 1, sub, 17, P.muted);
    loop(-w / 2 + 44, 40, color); text(29, 40, active ? '自主 Loop' : '等待选中', 18, color);
  });
  const box = (x, y, w, h, title, sub, color = P.blue, fill = P.blueFill) => {
    rect(x - w / 2, y - h / 2, w, h, fill, color); text(x, y - (sub ? 15 : 0), title, 25, color);
    if (sub) text(x, y + 20, sub, 18, P.muted);
  };
  const person = (x, y, title = '用户') => {
    c.circle(x, y - 14, 13, { stroke: P.blue, fill: P.blueFill, strokeWidth: 2 });
    c.path(`M ${x - 25} ${y + 23} Q ${x - 23} ${y + 2} ${x} ${y + 2} Q ${x + 23} ${y + 2} ${x + 25} ${y + 23}`,
      { stroke: P.blue, fill: P.blueFill, strokeWidth: 2 }); text(x, y + 51, title, 21);
  };
  const document = (x, y, title, color = P.green) => {
    rect(x - 58, y - 44, 116, 88, P.white, color);
    [0, 1, 2].forEach(i => c.line([[x - 37, y - 22 + i * 17], [x + 32 - i * 9, y - 22 + i * 17]], { stroke: color, strokeWidth: 3 }));
    text(x, y + 64, title, 20, color);
  };
  const footer = value => { c.line([[64, 705], [1216, 705]], { stroke: P.line }); left(66, 733, value, 18, P.muted); };
  rect(0, 0, 1280, 760, P.white, 'transparent', { round: false });
  left(64, 43, `${String(meta.id).padStart(2, '0')}  /  ${meta.en}`, 16, P.muted);
  left(64, 94, meta.title, 37); left(65, 140, meta.idea, 22, P.muted);
  tag(1090, 91, meta.control, P.purple, P.purpleFill);
  return { c, text, left, rect, arrow, tag, dot, loop, bot, agent, box, person, document, footer };
}
