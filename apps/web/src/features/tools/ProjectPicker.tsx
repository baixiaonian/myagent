/**
 * 输入区项目菜单：优先选最近项目或唤起原生目录窗口，路径输入/浏览按需展开。
 * 选择只登记目录，首次发送才创建对话；关闭后忽略异步返回，不能把迟到选择写入新草稿。
 */
import "./project-picker.css";
import type { ChatClient, DirectoryListing, Workspace } from "@myagent/sdk";
import {
  ArrowLeft,
  Check,
  Folder,
  FolderOpen,
  LoaderCircle,
  Search,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../../components/Modal.js";

export function ProjectPicker({
  client,
  selected,
  onSelect,
  onClose,
}: {
  client: ChatClient;
  selected: Workspace | null;
  onSelect: (project: Workspace | null) => void;
  onClose: () => void;
}) {
  const [recent, setRecent] = useState<Workspace[]>([]);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const alive = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const trigger = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void client
      .projects()
      .then((r) => {
        if (!cancelled) setRecent(r.projects);
      })
      .catch((e) => {
        if (!cancelled) setNotice(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [client]);
  useEffect(() => {
    if (manual) return;
    search.current?.focus();
    // 非模态菜单允许点击聊天区继续编辑；不拦截外部焦点、不用整页遮罩。
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !panel.current?.parentElement?.contains(event.target)
      )
        closeRef.current();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [manual]);
  function close() {
    onClose();
    trigger.current?.focus();
  }
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (alive.current)
        setNotice(e instanceof Error ? e.message : "目录操作失败。");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function browse(value?: string) {
    const next = await client.directories(value);
    if (alive.current) {
      setListing(next);
      setPath(next.path);
    }
  }
  async function select(value: string) {
    const project = await client.prepareProject(value.trim());
    if (alive.current) {
      onSelect(project);
      close();
    }
  }
  async function native() {
    const result = await client.pickDirectory();
    if (!alive.current) return;
    if (result.status === "selected" && result.path) await select(result.path);
    else if (result.status === "unavailable") {
      setManual(true);
      await browse();
      if (alive.current) setNotice(result.message ?? "请选择下方目录。");
    }
  }
  const matches = recent.filter((p) =>
    `${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase()),
  );
  if (manual)
    return (
      <Modal title="选择本地目录" onClose={close}>
        <p className="field-hint">目录位于运行 MyAgent 的这台电脑上。</p>
        <form
          className="project-path-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action(() => select(path));
          }}
        >
          <label>
            目录路径
            <input
              autoComplete="off"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/你的用户名/项目"
            />
          </label>
          {notice && (
            <p className="notice error" role="alert">
              {notice}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void action(() => browse(path || undefined))}
            >
              浏览目录
            </button>
            <button
              className="button primary"
              disabled={busy || !path.trim()}
              type="submit"
            >
              使用此目录
            </button>
          </div>
        </form>
        {listing && (
          <section className="directory-list" aria-label="本机目录">
            <code>{listing.path}</code>
            {listing.parent && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(() => browse(listing.parent as string))
                }
              >
                <ArrowLeft size={15} /> 上级目录
              </button>
            )}
            {listing.directories.map((name) => (
              <button
                type="button"
                key={name}
                disabled={busy}
                onClick={() =>
                  void action(() => browse(`${listing.path}/${name}`))
                }
              >
                <Folder size={15} /> {name}
              </button>
            ))}
            {!listing.directories.length && (
              <p className="muted">没有子目录，可以使用当前目录。</p>
            )}
          </section>
        )}
      </Modal>
    );
  return (
    <div
      ref={panel}
      className="project-popover"
      role="dialog"
      aria-label="选择项目"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
        // 搜索框按下箭头进入结果，之后用 Tab 在真实按钮间移动。
        if (e.key === "ArrowDown" && e.target === search.current) {
          e.preventDefault();
          panel.current
            ?.querySelector<HTMLButtonElement>(".project-option")
            ?.focus();
        }
      }}
    >
      <div className="project-search">
        <Search size={16} />
        <input
          ref={search}
          aria-label="搜索最近项目"
          placeholder="搜索项目…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="关闭项目菜单"
          onClick={close}
        >
          <X size={15} />
        </button>
      </div>
      <div className="project-options">
        {!query && (
          <button
            type="button"
            className="project-option"
            disabled={busy}
            onClick={() => {
              onSelect(null);
              close();
            }}
          >
            <Folder size={17} />
            <span>
              <strong>使用默认目录</strong>
              <small>为新对话创建独立文件夹</small>
            </span>
            {!selected && <Check size={15} />}
          </button>
        )}
        <p className="menu-caption">最近项目</p>
        {loading && <p className="menu-empty">正在读取…</p>}
        {matches.map((p) => (
          <button
            type="button"
            className="project-option"
            key={p.id}
            disabled={busy}
            title={p.path}
            onClick={() => void action(() => select(p.path))}
          >
            <Folder size={17} />
            <span>
              <strong>{p.name}</strong>
              <small>{p.path}</small>
            </span>
            {selected?.path === p.path && <Check size={15} />}
          </button>
        ))}
        {!loading && !matches.length && (
          <p className="menu-empty">
            {query ? "没有匹配的项目" : "选择过的项目会显示在这里"}
          </p>
        )}
      </div>
      {notice && (
        <p className="project-notice" role="alert">
          {notice}
        </p>
      )}
      <div className="project-menu-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void action(native)}
        >
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <FolderOpen size={16} />
          )}
          选择本地目录
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setNotice("");
            setManual(true);
          }}
        >
          <Terminal size={16} />
          输入目录路径…
        </button>
      </div>
    </div>
  );
}
