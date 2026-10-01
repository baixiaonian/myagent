/** 教学评测的两个固定代码样例；属于输入材料，由演示页面模拟状态，不是完整 JS 解释器。 */
// 示例 A
console.log("A");
setTimeout(() => console.log("B"), 0);
Promise.resolve().then(() => console.log("C"));
queueMicrotask(() => console.log("D"));
console.log("E");

// 示例 B（与 A 独立运行）
console.log("A");
setTimeout(() => {
  console.log("B");
  Promise.resolve().then(() => console.log("E"));
}, 0);
Promise.resolve().then(() => {
  console.log("C");
  queueMicrotask(() => console.log("D"));
});
