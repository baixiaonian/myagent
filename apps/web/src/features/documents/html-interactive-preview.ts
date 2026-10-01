/** HTML 交互预览适配：文档工作区调用，保留内嵌脚本与页面交互，但不给同源、网络和文件写回能力。
 * 可信外层承载不可信内层；外层 frame-src 阻止内层通过 location 导航绕过 connect-src。
 * 仅生成展示副本，不序列化回原文件，不提供选区编辑或宿主 API 桥。
 */
import {
  type DefaultTreeAdapterMap,
  defaultTreeAdapter,
  html,
  parse,
  serialize,
} from "parse5";

const offlinePolicy =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

/** 纯解析树处理不触发资源预加载；原始 CSP/跳转元数据不能影响展示副本的边界。 */
export function htmlInteractivePreview(content: string): string {
  const doc = parse(content);
  const forbidden = new Set([
    "base",
    "meta",
    "link",
    "iframe",
    "object",
    "embed",
  ]);
  const clean = (node: DefaultTreeAdapterMap["node"]) => {
    if ("childNodes" in node) {
      node.childNodes = node.childNodes.filter(
        (child) =>
          !(
            "tagName" in child &&
            (forbidden.has(child.tagName) ||
              (child.tagName === "script" &&
                child.attrs.some((a) => a.name === "src")))
          ),
      );
      for (const child of node.childNodes) clean(child);
    }
    if ("content" in node) clean(node.content);
  };
  clean(doc);
  const root = doc.childNodes.find(
    (node) => "tagName" in node && node.tagName === "html",
  );
  const head =
    root && "childNodes" in root
      ? root.childNodes.find(
          (node) => "tagName" in node && node.tagName === "head",
        )
      : undefined;
  if (head && "childNodes" in head) {
    const meta = defaultTreeAdapter.createElement("meta", html.NS.HTML, [
      { name: "http-equiv", value: "Content-Security-Policy" },
      { name: "content", value: `${offlinePolicy}; frame-src 'none'` },
    ]);
    meta.parentNode = head;
    head.childNodes.unshift(meta);
  }
  // 必须转义 <，防止正文中的 </script> 提前关闭可信外层的脚本标签。
  const payload = JSON.stringify(serialize(doc)).replace(/</g, "\\u003c");
  // 内层不能访问外层 DOM，也不能把自身导航到 HTTP 接口；Blob 继承外层 CSP，内层再收紧 frame-src。
  // 不建立 message 监听：即使文档伪造选区/保存消息，也没有可以调用的写入入口。
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${offlinePolicy}; frame-src blob:"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe title="HTML 交互内容" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script>const url=URL.createObjectURL(new Blob([${payload}],{type:'text/html;charset=utf-8'}));document.querySelector('iframe').src=url;addEventListener('pagehide',()=>URL.revokeObjectURL(url));</script></body></html>`;
}
