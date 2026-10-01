/** Markdown 富文本编辑器：仅文档发生编辑才序列化，打开/切页不会改写磁盘；不加载文档中的外部图片。 */
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import {
  type Editor,
  EditorContent,
  useEditor,
  useEditorState,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { prepareMarkdown } from "./markdown-preservation.js";
import type { DocumentSelection } from "./selection.js";

const SafeImage = Image.extend({
  renderHTML({ node }) {
    return [
      "span",
      { class: "document-image-placeholder" },
      `[图片：${String(node.attrs.alt || node.attrs.src || "图片")}]`,
    ];
  },
});
function Toolbar({ editor }: { editor: Editor }) {
  useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      selection: e.state.selection,
      doc: e.state.doc,
    }),
  });
  const [link, setLink] = useState<string | null>(null);
  const button = (
    label: string,
    icon: React.ReactNode,
    action: () => void,
    active = false,
    disabled = false,
  ) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
    >
      {icon}
    </button>
  );
  return (
    <>
      <div
        className="document-format-toolbar"
        data-preserve-document-selection
        role="toolbar"
        aria-label="文档格式工具栏"
      >
        <select
          aria-label="段落样式"
          value={
            editor.isActive("heading")
              ? String(editor.getAttributes("heading").level)
              : "0"
          }
          onChange={(e) => {
            const n = Number(e.target.value);
            if (n)
              editor
                .chain()
                .focus()
                .setHeading({ level: n as 1 | 2 | 3 })
                .run();
            else editor.chain().focus().setParagraph().run();
          }}
        >
          <option value="0">正文</option>
          <option value="1">标题 1</option>
          <option value="2">标题 2</option>
          <option value="3">标题 3</option>
        </select>
        {button(
          "加粗",
          <Bold size={16} />,
          () => editor.chain().focus().toggleBold().run(),
          editor.isActive("bold"),
        )}
        {button(
          "斜体",
          <Italic size={16} />,
          () => editor.chain().focus().toggleItalic().run(),
          editor.isActive("italic"),
        )}
        {button(
          "删除线",
          <Strikethrough size={16} />,
          () => editor.chain().focus().toggleStrike().run(),
          editor.isActive("strike"),
        )}
        {button(
          "无序列表",
          <List size={16} />,
          () => editor.chain().focus().toggleBulletList().run(),
          editor.isActive("bulletList"),
        )}
        {button(
          "有序列表",
          <ListOrdered size={16} />,
          () => editor.chain().focus().toggleOrderedList().run(),
          editor.isActive("orderedList"),
        )}
        {button(
          "任务清单",
          <ListTodo size={16} />,
          () => editor.chain().focus().toggleTaskList().run(),
          editor.isActive("taskList"),
        )}
        {button(
          "引用",
          <Quote size={16} />,
          () => editor.chain().focus().toggleBlockquote().run(),
          editor.isActive("blockquote"),
        )}
        {button(
          "代码块",
          <Code size={16} />,
          () => editor.chain().focus().toggleCodeBlock().run(),
          editor.isActive("codeBlock"),
        )}
        {button(
          "插入链接",
          <Link size={16} />,
          () => setLink(String(editor.getAttributes("link").href ?? "")),
          editor.isActive("link"),
        )}
        {button("插入表格", <Table size={16} />, () =>
          editor
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run(),
        )}
        {button("分隔线", <Minus size={16} />, () =>
          editor.chain().focus().setHorizontalRule().run(),
        )}
        <span className="toolbar-spacer" />
        {button(
          "撤销",
          <Undo2 size={16} />,
          () => editor.chain().focus().undo().run(),
          false,
          !editor.can().undo(),
        )}
        {button(
          "重做",
          <Redo2 size={16} />,
          () => editor.chain().focus().redo().run(),
          false,
          !editor.can().redo(),
        )}
      </div>
      {editor.isActive("table") && (
        <div className="document-table-tools">
          <button
            type="button"
            onClick={() => editor.chain().focus().addRowAfter().run()}
          >
            添加行
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().addColumnAfter().run()}
          >
            添加列
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().deleteRow().run()}
          >
            删除行
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().deleteColumn().run()}
          >
            删除列
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().deleteTable().run()}
          >
            删除表格
          </button>
        </div>
      )}
      {link !== null && (
        <form
          className="document-link-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!link) editor.chain().focus().unsetLink().run();
            else if (/^(https?:\/\/|mailto:|\/|\.|#)/i.test(link))
              editor.chain().focus().setLink({ href: link }).run();
            else return;
            setLink(null);
          }}
        >
          <input
            aria-label="链接地址"
            placeholder="https://…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <button type="submit">应用链接</button>
          <button type="button" onClick={() => setLink(null)}>
            取消
          </button>
        </form>
      )}
    </>
  );
}
export function MarkdownEditor({
  content,
  onChange,
  onSelection,
  onComposing,
}: {
  content: string;
  onChange: (s: string) => void;
  onComposing: (composing: boolean) => void;
  onSelection: (s: DocumentSelection | null, source?: string) => void;
}) {
  const [prepared] = useState(() => prepareMarkdown(content));
  const capture = (e: Editor, source?: string) => {
    const { from, to } = e.state.selection;
    const text = e.state.doc.textBetween(from, to, "\n");
    if (from === to) {
      if (e.view.hasFocus()) onSelection(null);
      return;
    }
    if (!text.trim()) return;
    const start = e.view.coordsAtPos(from),
      end = e.view.coordsAtPos(to);
    onSelection(
      {
        from,
        to,
        text,
        rect: { left: start.left, top: start.top, bottom: end.bottom },
      },
      source,
    );
  };
  const editor: Editor | null = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false },
        underline: false,
        trailingNode: false,
      }),
      Markdown,
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      SafeImage,
    ],
    content: prepared.content,
    contentType: "markdown",
    editorProps: {
      handleDOMEvents: {
        // 重选相同范围时 ProseMirror 不派发 selectionUpdate，鼠标释放后仍须恢复就地操作条。
        mouseup: () => {
          requestAnimationFrame(() => {
            if (editor && !editor.isDestroyed) capture(editor);
          });
          return false;
        },
        compositionstart: () => {
          onComposing(true);
          return false;
        },
        compositionend: () => {
          onComposing(false);
          return false;
        },
      },
      attributes: {
        class: "document-prose",
        role: "textbox",
        "aria-label": "文档正文",
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor: e }) => {
      if (!e.isInitialized) return;
      const source = prepared.restore(e.getMarkdown());
      onChange(source);
      capture(e, source);
    },
    onSelectionUpdate: ({ editor: e }) => capture(e),
  });
  return editor ? (
    <div className="rich-document">
      <Toolbar editor={editor} />
      <div className="document-editor-scroll">
        <EditorContent editor={editor} />
      </div>
    </div>
  ) : null;
}
