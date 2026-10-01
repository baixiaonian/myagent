/** 单页 Markdown 的保真片段：富文本暂不理解的元数据/HTML/脚注以正文内代码块编辑，写回时恢复原语法。 */
export function prepareMarkdown(content: string) {
  const originals: string[] = [];
  let tag = "myagent-preserved";
  // 避免把用户自己编写的同名代码围栏误识别为保真片段。
  while (content.includes(tag)) tag += "x";
  const wrap = (source: string) => {
    const id = originals.push(source) - 1;
    return `\n\n\`\`\`${tag}-${id}\n${source}\n\`\`\`\n\n`;
  };
  let body = content;
  let prefix = "";
  const front =
    /^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
      body,
    );
  if (front) {
    prefix = wrap(front[0].replace(/\r?\n$/, ""));
    body = body.slice(front[0].length);
  }
  const lines = body.split("\n"),
    out: string[] = [];
  let buffer: string[] = [],
    fence = "";
  const flush = () => {
    if (!buffer.length) return;
    const block = buffer.join("\n");
    out.push(
      /<!--|<\/?[A-Za-z][^>]*>|\[\^|^\s*\[[^\]]+\]:|\[[^\]]+\]\[[^\]]*\]|\$\$|\\\[|^:::/m.test(
        block,
      )
        ? wrap(block)
        : block,
    );
    buffer = [];
  };
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length)
        fence = "";
      continue;
    }
    if (marker) {
      flush();
      fence = marker;
      out.push(line);
      continue;
    }
    const collected = buffer.join("\n");
    const inComment =
      collected.lastIndexOf("<!--") > collected.lastIndexOf("-->");
    if (!line.trim() && !inComment) {
      flush();
      out.push(line);
    } else buffer.push(line);
  }
  flush();
  return {
    content: prefix + out.join("\n"),
    restore: (markdown: string) =>
      markdown.replace(
        new RegExp(
          `^(${"`"}{3,})${tag}-(\\d+)\\n([\\s\\S]*?)^\\1[ \\t]*$`,
          "gm",
        ),
        (_all, _fence, id: string, text: string) => {
          const value = text.replace(/\n$/, "");
          const original = originals[Number(id)];
          if (original === undefined) return _all;
          return original !== undefined &&
            original.replace(/\r\n/g, "\n") === value
            ? original
            : value;
        },
      ),
  };
}
