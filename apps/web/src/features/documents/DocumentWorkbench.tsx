/** 右侧文档工作区：按项目保留多文档草稿，串行自动保存与版本冲突比较；切换和折叠不丢失待提交修改。
 * 选区只能由用户加入聊天草稿，不自动发送或执行模型；已打开正文不放入浏览器持久存储。
 */
import type { ChatClient, ProjectDocument, Workspace } from "@myagent/sdk";
import {
  Bold,
  Check,
  FileText,
  FolderTree,
  Italic,
  LoaderCircle,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileTree } from "./FileTree.js";
import { HtmlEditor } from "./HtmlEditor.js";
import { MarkdownEditor } from "./MarkdownEditor.js";
import type { SelectedFragment } from "./SelectedFragments.js";
import { SelectionPopover } from "./SelectionPopover.js";
import type { DocumentSelection } from "./selection.js";
import { useDocumentSave } from "./use-document-save.js";
import "./documents.css";

interface Tab {
  file: ProjectDocument;
  draft: string;
  version: number;
}
export type DocumentQuote = Omit<SelectedFragment, "id">;
export function DocumentWorkbench({
  client,
  workspace,
  open,
  request,
  onClose,
  onQuote,
}: {
  client: ChatClient;
  workspace: Workspace | null;
  open: boolean;
  request: { workspaceId: string; path: string; nonce: number } | null;
  onClose: () => void;
  onQuote: (q: DocumentQuote) => void;
}) {
  const [projects, setProjects] = useState<
    Record<string, { tabs: Tab[]; active: string }>
  >({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tree, setTree] = useState(() => window.innerWidth >= 650);
  const [refresh, setRefresh] = useState(0);
  const [wide, setWide] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const savers = useRef(new Map<string, () => Promise<boolean>>());
  const registerSave = useCallback(
    (key: string, save: (() => Promise<boolean>) | null) => {
      if (save) savers.current.set(key, save);
      else savers.current.delete(key);
    },
    [],
  );
  const id = workspace?.id ?? "";
  const current = projects[id] ?? { tabs: [], active: "" };
  const stateRef = useRef(projects);
  stateRef.current = projects;
  const currentId = useRef(id);
  currentId.current = id;
  const openSerial = useRef(0);
  const update = useCallback(
    (wid: string, path: string, fn: (tab: Tab) => Tab) =>
      setProjects((old) => ({
        ...old,
        [wid]: {
          ...(old[wid] ?? { active: path, tabs: [] }),
          tabs: (old[wid]?.tabs ?? []).map((t) =>
            t.file.path === path ? fn(t) : t,
          ),
        },
      })),
    [],
  );
  const openFile = useCallback(
    async (wid: string, path: string) => {
      const serial = ++openSerial.current;
      setError("");
      const revisions = new Map(
        (stateRef.current[wid]?.tabs ?? []).map((t) => [
          t.file.path,
          t.file.revision,
        ]),
      );
      const existing = stateRef.current[wid]?.tabs.find(
        (t) => t.file.path === path,
      );
      if (existing) {
        setProjects((old) => ({
          ...old,
          [wid]: { ...(old[wid] ?? { tabs: [] }), active: existing.file.path },
        }));
      }
      setLoading(true);
      try {
        const file = await client.document(wid, path);
        setProjects((old) => {
          const value = old[wid] ?? { tabs: [], active: "" };
          return {
            ...old,
            [wid]: {
              // 用户再次点击交付文件时刷新干净标签；请求期间的保存和未保存草稿优先保留。
              tabs: value.tabs.some((t) => t.file.path === file.path)
                ? value.tabs.map((t) =>
                    t.file.path === file.path &&
                    t.file.revision === revisions.get(t.file.path) &&
                    t.draft === t.file.content &&
                    t.file.revision !== file.revision
                      ? { file, draft: file.content, version: t.version + 1 }
                      : t,
                  )
                : [...value.tabs, { file, draft: file.content, version: 0 }],
              active: serial === openSerial.current ? file.path : value.active,
            },
          };
        });
      } catch (e) {
        if (currentId.current === wid && serial === openSerial.current)
          setError(e instanceof Error ? e.message : "打开失败");
      } finally {
        if (serial === openSerial.current) setLoading(false);
      }
    },
    [client],
  );
  useEffect(() => {
    if (request) void openFile(request.workspaceId, request.path);
  }, [request, openFile]);
  const dirty = Object.values(projects).some((p) =>
    p.tabs.some((t) => t.draft !== t.file.content),
  );
  useEffect(() => {
    if (!dirty) return;
    const prevent = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  async function closeTab(path: string) {
    const wid = id;
    const saved = await savers.current.get(`${wid}:${path}`)?.();
    if (saved === false) {
      setError("这份文档还未保存成功，请先处理保存提示。");
      return;
    }
    setError("");
    setProjects((old) => {
      const value = old[id];
      if (!value) return old;
      const tabs = value.tabs.filter((t) => t.file.path !== path);
      return {
        ...old,
        [id]: {
          tabs,
          active:
            value.active === path
              ? (tabs.at(-1)?.file.path ?? "")
              : value.active,
        },
      };
    });
  }
  return (
    <aside
      aria-label="文档工作区"
      className={`document-workbench ${wide ? "document-wide" : ""}`}
      hidden={!open}
      style={width && !wide ? { width } : undefined}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: 可交互分隔条需要拖动与方向键，不是装饰性横线。 */}
      <div
        role="separator"
        aria-label="调整文档面板宽度"
        aria-orientation="vertical"
        aria-valuemin={420}
        aria-valuemax={1600}
        aria-valuenow={width ?? 650}
        tabIndex={0}
        className="document-resizer"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            setWidth((v) =>
              Math.max(
                420,
                Math.min(
                  window.innerWidth - 320,
                  (v ?? 650) + (e.key === "ArrowLeft" ? 30 : -30),
                ),
              ),
            );
          }
        }}
        onPointerDown={(e) => {
          drag.current = {
            x: e.clientX,
            width:
              e.currentTarget.parentElement?.getBoundingClientRect().width ??
              650,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setWidth(
              Math.max(
                420,
                Math.min(
                  window.innerWidth - 320,
                  drag.current.width + drag.current.x - e.clientX,
                ),
              ),
            );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      />
      <header className="document-workbench-header">
        <div>
          <FileText size={17} />
          <strong>文档</strong>
          <span title={workspace?.path}>
            {workspace?.name ?? "选择项目后浏览文档"}
          </span>
        </div>
        <div>
          <button
            type="button"
            className="icon-button"
            aria-label="切换项目目录"
            aria-pressed={tree}
            onClick={() => setTree((v) => !v)}
          >
            <FolderTree size={17} />
          </button>
          <button
            type="button"
            className="icon-button document-expand"
            aria-label={wide ? "还原文档面板" : "展开文档面板"}
            onClick={() => setWide((v) => !v)}
          >
            {wide ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="收起文档面板"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="document-workbench-body">
        <div className="document-main">
          <div className="document-tabbar">
            <div
              className="document-tabs"
              role="tablist"
              aria-label="已打开文档"
            >
              {current.tabs.map((t) => (
                <div
                  className={`document-tab ${current.active === t.file.path ? "active" : ""}`}
                  key={t.file.path}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={current.active === t.file.path}
                    title={t.file.path}
                    onClick={() =>
                      setProjects((old) => ({
                        ...old,
                        [id]: { ...current, active: t.file.path },
                      }))
                    }
                  >
                    <FileText size={13} />
                    <span>{t.file.path.split("/").at(-1)}</span>
                    {t.draft !== t.file.content && (
                      <span
                        className="document-dirty"
                        role="img"
                        aria-label="未保存"
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`关闭 ${t.file.path}`}
                    onClick={() => void closeTab(t.file.path)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
            <div className="document-tab-actions" ref={setControlsHost} />
          </div>
          {error && (
            <div className="document-error" role="alert">
              {error}
              <button type="button" onClick={() => setError("")}>
                关闭提示
              </button>
            </div>
          )}
          {loading && (
            <div className="document-loading">
              <LoaderCircle size={15} className="spin" /> 正在打开文档…
            </div>
          )}
          {current.tabs.length === 0 && (
            <div className="document-empty">
              <FileText size={36} />
              <h2>让文档和对话并排</h2>
              <p>
                点击回答中的文件路径，或从右侧目录打开
                <br />
                Markdown 与 HTML 文档。
              </p>
              <span>直接编辑 · 自动保存 · 选段提问</span>
            </div>
          )}
          {Object.entries(projects).flatMap(([wid, value]) =>
            value.tabs.map((tab) => (
              <div
                key={`${wid}:${tab.file.path}`}
                className="document-tab-body"
                hidden={wid !== id || current.active !== tab.file.path}
              >
                <DocumentTab
                  client={client}
                  workspaceId={wid}
                  tab={tab}
                  active={
                    open && wid === id && current.active === tab.file.path
                  }
                  update={(fn) => update(wid, tab.file.path, fn)}
                  onQuote={onQuote}
                  registerSave={registerSave}
                  controlsHost={controlsHost}
                />
              </div>
            )),
          )}
        </div>
        {tree && (
          <nav className="document-tree" aria-label="项目文件目录">
            <header>
              <span>项目文件</span>
              <button
                type="button"
                className="icon-button"
                aria-label="刷新文件目录"
                onClick={() => setRefresh((v) => v + 1)}
              >
                <RefreshCw size={14} />
              </button>
            </header>
            {workspace ? (
              <FileTree
                client={client}
                workspaceId={id}
                active={current.active}
                onOpen={(p) => void openFile(id, p)}
                refresh={refresh}
              />
            ) : (
              <p>先选择项目或打开已有对话。</p>
            )}
            <footer>
              Markdown / HTML
              <br />
              目录按需展开
            </footer>
          </nav>
        )}
      </div>
    </aside>
  );
}

/** 每个打开的文档常驻页面，切换项目或折叠时也完成自己的保存队列。 */
function DocumentTab({
  client,
  workspaceId,
  tab,
  active,
  update,
  onQuote,
  registerSave,
  controlsHost,
}: {
  client: ChatClient;
  workspaceId: string;
  tab: Tab;
  active: boolean;
  controlsHost: HTMLDivElement | null;
  update: (fn: (t: Tab) => Tab) => void;
  onQuote: (q: DocumentQuote) => void;
  registerSave: (key: string, save: (() => Promise<boolean>) | null) => void;
}) {
  const [selection, setSelection] = useState<DocumentSelection | null>(null);
  const [selectionBase, setSelectionBase] = useState("");
  const [htmlMode, setHtmlMode] = useState<"preview" | "edit">("preview");
  const [composing, setComposing] = useState(false);
  const [notice, setNotice] = useState("");
  const latestTab = useRef(tab);
  latestTab.current = tab;
  const autosave = useDocumentSave(
    client,
    workspaceId,
    tab.file,
    tab.draft,
    (file) => update((t) => ({ ...t, file })),
    composing,
  );
  const dirty = tab.draft !== tab.file.content;
  useEffect(() => {
    const key = `${workspaceId}:${tab.file.path}`;
    registerSave(key, autosave.flush);
    return () => registerSave(key, null);
  }, [workspaceId, tab.file.path, registerSave, autosave.flush]);
  useEffect(() => {
    if (!active) {
      setSelection(null);
      return;
    }
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!e.isComposing) void autosave.flush();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [active, autosave.flush]);
  const dismiss = useCallback(() => setSelection(null), []);
  const select = useCallback(
    (next: DocumentSelection | null, source = tab.draft) => {
      setSelection(next);
      setSelectionBase(source);
    },
    [tab.draft],
  );
  const change = (draft: string) => {
    update((t) => ({ ...t, draft }));
    setNotice("");
    setSelection(null);
  };
  async function reload() {
    if (!(await autosave.flush())) return;
    const before = latestTab.current;
    try {
      const file = await client.document(workspaceId, tab.file.path);
      // 读取磁盘期间可以继续输入；迟到的刷新不得替换新草稿或刚完成的自动保存。
      if (
        latestTab.current.draft !== before.draft ||
        latestTab.current.file.revision !== before.file.revision
      ) {
        setNotice("读取期间文档已修改，已保留当前编辑。");
        return;
      }
      autosave.adopt(file);
      update((t) => ({
        ...t,
        file,
        draft: file.content,
        version: t.version + 1,
      }));
      setSelection(null);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "读取失败");
    }
  }
  function quote() {
    if (!selection) return;
    onQuote({
      workspaceId,
      path: tab.file.path,
      revision: tab.file.revision,
      text: selection.text,
      unsaved: dirty,
    });
    setSelection(null);
  }
  // HTML 工具栏仍按原文偏移包裹格式；选区浮层不再承担正文替换。
  function formatHtml(markup: "strong" | "em") {
    if (htmlMode !== "edit" || !selection || selectionBase !== tab.draft) {
      setNotice("文档已变化，请重新选择文本。");
      return;
    }
    if (selection.from < 0) return;
    change(
      tab.draft.slice(0, selection.from) +
        `<${markup}>${tab.draft.slice(selection.from, selection.to)}</${markup}>` +
        tab.draft.slice(selection.to),
    );
    setSelection(null);
  }
  return (
    <>
      {/* 保存队列仍由文档持有，只有当前标签把操作投影到共用标签栏。 */}
      {active &&
        controlsHost &&
        createPortal(
          <>
            <span
              className={`document-save-status ${autosave.error ? "has-error" : ""}`}
              role="status"
              aria-label="文档保存状态"
            >
              {autosave.saving ? (
                <LoaderCircle size={12} className="spin" />
              ) : !dirty ? (
                <Check size={12} />
              ) : null}
              {autosave.saving
                ? "正在保存…"
                : autosave.conflict
                  ? "存在冲突"
                  : autosave.error
                    ? "保存失败"
                    : dirty
                      ? "等待保存"
                      : "已保存"}
            </span>
            <button
              type="button"
              disabled={autosave.saving}
              className="icon-button"
              aria-label="重新载入文档"
              title="刷新磁盘内容"
              onClick={() => void reload()}
            >
              <RefreshCw size={14} />
            </button>
          </>,
          controlsHost,
        )}
      {tab.file.format === "html" && (
        <div
          className="document-format-toolbar"
          data-preserve-document-selection
          role="toolbar"
          aria-label="HTML 格式工具栏"
        >
          <div className="document-html-modes">
            <button
              type="button"
              aria-pressed={htmlMode === "preview"}
              title="运行内嵌脚本和筛选交互，外部资源与网络保持关闭"
              onClick={() => {
                setSelection(null);
                setHtmlMode("preview");
              }}
            >
              交互预览
            </button>
            <button
              type="button"
              aria-pressed={htmlMode === "edit"}
              title="编辑静态文字格式，页面脚本暂停运行"
              onClick={() => {
                setSelection(null);
                setHtmlMode("edit");
              }}
            >
              文字编辑
            </button>
          </div>
          {htmlMode === "edit" && (
            <>
              <button
                type="button"
                aria-label="HTML 选段加粗"
                disabled={!selection || selection.from < 0}
                onClick={() => formatHtml("strong")}
              >
                <Bold size={16} />
              </button>
              <button
                type="button"
                aria-label="HTML 选段斜体"
                disabled={!selection || selection.from < 0}
                onClick={() => formatHtml("em")}
              >
                <Italic size={16} />
              </button>
            </>
          )}
        </div>
      )}
      {(notice || autosave.error) && (
        <div className="document-error" role="alert">
          {notice || autosave.error}
          {autosave.error && !autosave.conflict && (
            <button type="button" onClick={autosave.retry}>
              重试保存
            </button>
          )}
        </div>
      )}
      {autosave.conflict && (
        <div className="document-conflict">
          <strong>磁盘有更新，自动保存已暂停</strong>
          <details>
            <summary>比较磁盘版本和我的修改</summary>
            <div className="document-compare">
              <section>
                <h4>磁盘版本</h4>
                <pre>{autosave.conflict.content}</pre>
              </section>
              <section>
                <h4>我的修改</h4>
                <pre>{tab.draft}</pre>
              </section>
            </div>
          </details>
          <div>
            <button
              type="button"
              onClick={() => {
                const file = autosave.conflict;
                if (!file) return;
                autosave.adopt(file);
                update((t) => ({
                  ...t,
                  file,
                  draft: file.content,
                  version: t.version + 1,
                }));
                setSelection(null);
              }}
            >
              采用磁盘版本
            </button>
            <button
              type="button"
              onClick={() => {
                const file = autosave.conflict;
                if (!file) return;
                autosave.adopt(file);
                update((t) => ({ ...t, file }));
              }}
            >
              使用我的版本
            </button>
          </div>
        </div>
      )}
      <div className="document-content">
        {tab.file.format === "html" ? (
          <HtmlEditor
            key={tab.version}
            content={tab.draft}
            mode={htmlMode}
            onSelection={select}
          />
        ) : (
          <MarkdownEditor
            key={tab.version}
            content={tab.draft}
            onChange={change}
            onSelection={select}
            onComposing={setComposing}
          />
        )}
      </div>
      {active && selection?.text.trim() && (
        <SelectionPopover
          key={`${selection.from}:${selection.to}:${selectionBase}`}
          selection={selection}
          onQuote={quote}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}
