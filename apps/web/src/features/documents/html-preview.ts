/** HTML 文档预览：保留静态样式，移除执行入口；仅注入受 nonce 限制的选区桥，不授予同源、网络、弹窗或表单权限。
 * 文本节点用 parse5 原文偏移定位，局部替换不重建整份 HTML，因此 head、脚本源文与布局保持原样。
 */
import {
  type DefaultTreeAdapterMap,
  defaultTreeAdapter,
  html,
  parse,
  serialize,
} from "parse5";

type HtmlNode = DefaultTreeAdapterMap["node"];
export function htmlPreview(content: string, token: string): string {
  const ranges: { start: number; end: number }[] = [];
  const walk = (node: HtmlNode, skip = false) => {
    const name = "tagName" in node ? node.tagName : "";
    const excluded =
      skip ||
      [
        "head",
        "script",
        "style",
        "textarea",
        "title",
        "noscript",
        "svg",
        "math",
        "select",
      ].includes(name);
    if (
      node.nodeName === "#text" &&
      !excluded &&
      "value" in node &&
      node.value.trim() &&
      node.sourceCodeLocation
    )
      ranges.push({
        start: node.sourceCodeLocation.startOffset,
        end: node.sourceCodeLocation.endOffset,
      });
    if ("childNodes" in node)
      for (const child of node.childNodes) walk(child, excluded);
  };
  walk(parse(content, { sourceCodeLocationInfo: true }));
  let marked = content;
  for (const r of ranges.sort((a, b) => b.start - a.start))
    marked =
      marked.slice(0, r.start) +
      `<span data-document-start="${r.start}" data-document-end="${r.end}" style="display:contents">` +
      marked.slice(r.start, r.end) +
      "</span>" +
      marked.slice(r.end);
  // 先在纯解析树中移除请求与执行入口，避免 DOMParser 预加载 img/iframe 产生隐式网络请求。
  const doc = parse(marked);
  const forbidden = new Set([
    "script",
    "iframe",
    "object",
    "embed",
    "base",
    "link",
    "meta",
    "template",
  ]);
  const clean = (node: HtmlNode) => {
    if ("attrs" in node)
      node.attrs = node.attrs.filter(
        (a) =>
          !/^on/i.test(a.name) &&
          ![
            "href",
            "src",
            "srcset",
            "action",
            "formaction",
            "autofocus",
            "contenteditable",
          ].includes(a.name),
      );
    if ("childNodes" in node) {
      node.childNodes = node.childNodes.filter(
        (child) => !("tagName" in child && forbidden.has(child.tagName)),
      );
      for (const child of node.childNodes) clean(child);
    }
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
      {
        name: "content",
        value: `default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`,
      },
    ]);
    meta.parentNode = head;
    head.childNodes.unshift(meta);
  }
  const bridgeCode = `(()=>{const emit=()=>{const s=getSelection();if(!s||s.isCollapsed||!s.rangeCount)return;const r=s.getRangeAt(0),a=(r.startContainer.nodeType===1?r.startContainer:r.startContainer.parentElement)?.closest('[data-document-start]'),b=(r.endContainer.nodeType===1?r.endContainer:r.endContainer.parentElement)?.closest('[data-document-start]');const offset=(node,pos)=>{if(!a)return 0;const v=document.createRange();v.setStart(a,0);v.setEnd(node,pos);return v.toString().length};parent.postMessage({kind:'document-selection',token:${JSON.stringify(token)},text:s.toString().slice(0,6000),rect:{left:r.getBoundingClientRect().left,top:r.getBoundingClientRect().top,bottom:r.getBoundingClientRect().bottom},start:a===b&&a?Number(a.dataset.documentStart):-1,end:a===b&&a?Number(a.dataset.documentEnd):-1,from:a===b?offset(r.startContainer,r.startOffset):0,to:a===b?offset(r.endContainer,r.endOffset):0},'*')};document.addEventListener('scroll',()=>parent.postMessage({kind:'document-selection-clear',token:${JSON.stringify(token)}},'*'),true);document.addEventListener('mouseup',emit);document.addEventListener('keyup',emit);document.addEventListener('click',e=>{if(e.target.closest('a,button,input,form'))e.preventDefault()});})();`;
  const bridge = `<script nonce="${token}">${bridgeCode}</script>`;
  return serialize(doc).replace("</body>", `${bridge}</body>`);
}
/** DOM 中字符偏移换算回原文；实体与 CRLF 保留源长度，选中 &amp; 后替换不能破坏相邻标签。 */
export function htmlSourceOffset(raw: string, offset: number): number {
  let visible = 0,
    index = 0;
  while (index < raw.length && visible < offset) {
    const match = /^(?:&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|\r\n)/i.exec(
      raw.slice(index),
    );
    if (match) {
      const box = document.createElement("textarea");
      box.innerHTML = match[0];
      visible += box.value.length;
      index += match[0].length;
    } else {
      visible++;
      index++;
    }
  }
  return index;
}
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
