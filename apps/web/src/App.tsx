/**
 * 聊天工作台：管理会话选择、草稿、模型设置入口、消息展示及移动侧栏。
 * 所有后端访问经 ChatClient；服务端快照和 SSE 是历史与运行状态的依据。
 * 重点维护迟到响应隔离、幂等重发、输入法 Enter、重新生成展示及用户阅读位置。
 */

import {
  ApiError,
  applyEvent,
  ChatClient,
  type ExecutionMode,
  type Message,
  type PublicSettings,
  type RegenerateInput,
  type RunInput,
  type Session,
  type SessionSnapshot,
  type Workspace,
} from "@myagent/sdk";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  Code2,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plug,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  SquarePen,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Modal } from "./components/Modal.js";
import { SettingsNavigation } from "./components/SettingsNavigation.js";
import { ContextPanel } from "./features/chat/ContextPanel.js";
import { HookProcess } from "./features/chat/HookProcess.js";
import { CopyButton, Markdown } from "./features/chat/Markdown.js";
import { RunProcess } from "./features/chat/RunProcess.js";
import { SessionNavigation } from "./features/chat/SessionNavigation.js";
import { SkillPicker } from "./features/chat/SkillPicker.js";
import { TeamPanel } from "./features/chat/TeamPanel.js";
import type { DocumentQuote } from "./features/documents/DocumentWorkbench.js";
import { DocumentNavigation } from "./features/documents/document-links.js";
import {
  fragmentContext,
  type SelectedFragment,
  SelectedFragments,
} from "./features/documents/SelectedFragments.js";
import {
  ObservabilityDialog,
  RunObservation,
} from "./features/observability/ObservabilityDialog.js";
import { HooksDialog } from "./features/settings/HooksDialog.js";
import { MemoryDialog } from "./features/settings/MemoryDialog.js";
import { PluginsDialog } from "./features/settings/PluginsDialog.js";
import { SettingsDialog } from "./features/settings/SettingsDialog.js";
import { SkillsDialog } from "./features/settings/SkillsDialog.js";
import { CommandSettingsDialog } from "./features/tools/CommandSettingsDialog.js";
import { ExecutionPanel } from "./features/tools/ExecutionPanel.js";
import { ProjectPermissions } from "./features/tools/ProjectPermissions.js";
import { ProjectPicker } from "./features/tools/ProjectPicker.js";
import { ToolSettingsDialog } from "./features/tools/ToolSettingsDialog.js";

const DocumentWorkbench = lazy(() =>
  import("./features/documents/DocumentWorkbench.js").then((m) => ({
    default: m.DocumentWorkbench,
  })),
);
const client = new ChatClient();
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试。";
const suggestions = [
  "介绍这个项目的结构和主要功能",
  "检查项目中可能存在的问题",
  "帮我整理一份清晰的使用文档",
];
interface Pending {
  kind: "send" | "regenerate";
  input: RunInput | RegenerateInput;
}
// 同一问题可能有多个答案版本：生成中优先展示候选，候选失败则回到最后成功答案。
// 已 superseded 的旧版本不再显示；没有成功答案时仍展示最后一次失败或停止的部分内容。
function visibleAnswers(messages: Message[]): Message[] {
  return messages
    .filter((message) => message.role === "user")
    .flatMap((question) => {
      const answers = messages.filter(
        (item) =>
          item.replyToId === question.id && item.status !== "superseded",
      );
      const selected =
        answers.findLast((item) => item.status === "generating") ??
        answers.findLast((item) => item.status === "completed") ??
        answers.at(-1);
      return selected ? [question, selected] : [question];
    });
}
export default function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [documentsMounted, setDocumentsMounted] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  useEffect(() => {
    if (documentsOpen) setDocumentsMounted(true);
  }, [documentsOpen]);
  const [documentRequest, setDocumentRequest] = useState<{
    workspaceId: string;
    path: string;
    nonce: number;
  } | null>(null);
  const [teamOpen, setTeamOpen] = useState(true);
  const [teamCount, setTeamCount] = useState(0);
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("session"),
  );
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  // 草稿按会话保留在当前页面内存；生成中的新草稿不提交，也不会因新消息到达而被清空。
  // 浏览器只保存用户的模式偏好；服务端仍在每个 Run 中冻结真实权限。
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(() => {
    try {
      return localStorage.getItem("myagent.execution-mode") === "full_access"
        ? "full_access"
        : "standard";
    } catch {
      return "standard";
    }
  });
  const [fragmentDrafts, setFragmentDrafts] = useState<
    Record<string, SelectedFragment[]>
  >({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [commandSettingsOpen, setCommandSettingsOpen] = useState(false);
  const [hookCursor, setHookCursor] = useState(0);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillDrafts, setSkillDrafts] = useState<Record<string, string[]>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [observationOpen, setObservationOpen] = useState<{
    runId?: string;
  } | null>(() =>
    new URLSearchParams(location.search).get("view") === "observability"
      ? {}
      : null,
  );
  const [observationRefresh, setObservationRefresh] = useState(0);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectPermissionsOpen, setProjectPermissionsOpen] = useState(false);
  const [draftProject, setDraftProject] = useState<Workspace | null>(null);
  const [preparingProject, setPreparingProject] = useState(false);
  const projectChoice = useRef(0);
  const [boundProject, setBoundProject] = useState<Workspace | null>(null);
  const createRequest = useRef<string | null>(null);
  const [confirmRerun, setConfirmRerun] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("connected");
  const [reload, setReload] = useState(0);
  const [manage, setManage] = useState<{
    kind: "rename" | "delete";
    session: Session;
  } | null>(null);
  const [title, setTitle] = useState("");
  const [manageBusy, setManageBusy] = useState(false);
  const [showBottom, setShowBottom] = useState(false);
  // 异步回调读取当前选择，避免旧会话的迟到 HTTP 结果覆盖刚切换的页面。
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const scroll = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // 只缓存结果不确定的命令，供用户下一次发送复用 requestId；不会自行重试或持续计费。
  const pending = useRef(new Map<string, Pending>());
  const draftKey = selected ?? "new";
  const draft = drafts[draftKey] ?? "";
  const fragments = fragmentDrafts[draftKey] ?? [];
  const busy =
    snapshot?.activeRun !== null && snapshot?.activeRun !== undefined;
  const messages = snapshot ? visibleAnswers(snapshot.messages) : [];
  const refreshList = useCallback(async () => {
    const [result, catalogue] = await Promise.all([
      client.listSessions(),
      client.workspaces(),
    ]);
    setSessions(result.sessions);
    setWorkspaces(catalogue.workspaces);
  }, []);
  // 同会话只接受不落后于当前 cursor 的快照，避免 HTTP 返回慢于 SSE 时把已显示文字回滚。
  const acceptSnapshot = useCallback((next: SessionSnapshot) => {
    if (selectedRef.current !== next.session.id) return;
    setSnapshot((current) =>
      current?.session.id === next.session.id && current.cursor > next.cursor
        ? current
        : next,
    );
  }, []);
  useEffect(() => {
    let alive = true;
    void client
      .workspaces()
      .then((value) => {
        if (alive) setWorkspaces(value.workspaces);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    Promise.all([client.settings(), client.listSessions()])
      .then(([value, list]) => {
        if (disposed) return;
        setSettings(value);
        setSessions(list.sessions);
        if (!value.configured) setSettingsOpen(true);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(errorText(reason));
      });
    return () => {
      disposed = true;
    };
  }, []);
  // 切换会话先读取带 cursor 的完整快照，再从同一游标订阅，覆盖两次请求之间的事件。
  // 下面的清理只解除订阅，用户关闭或刷新页面不会中止后端生成。
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload 是用户主动重连的触发器。
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set("session", selected);
    else url.searchParams.delete("session");
    history.replaceState({}, "", url);
    setError("");
    stickBottom.current = true;
    setShowBottom(false);
    setTeamOpen(true);
    setTeamCount(0);
    if (!selected) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    let disposed = false;
    let unsubscribe = () => {};
    setLoading(true);
    setSnapshot(null);
    client
      .session(selected)
      .then((value) => {
        if (disposed) return;
        acceptSnapshot(value);
        setLoading(false);
        unsubscribe = client.subscribe(
          selected,
          value.cursor,
          (event) => {
            if (disposed) return;
            if (event.type === "hook.updated") setHookCursor(event.seq);
            setSnapshot((current) =>
              current ? applyEvent(current, event) : current,
            );
            if (event.type === "session.updated")
              setSessions((items) =>
                [
                  event.session,
                  ...items.filter((item) => item.id !== event.session.id),
                ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
              );
          },
          (value) => {
            if (!disposed) setConnection(value);
          },
          (deleted) => {
            if (disposed) return;
            if (deleted) {
              setSelected(null);
              void refreshList();
            } else {
              setReload((value) => value + 1);
            }
          },
        );
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        setLoading(false);
        setError(errorText(reason));
        if (reason instanceof ApiError && reason.status === 404) {
          setSelected(null);
          void refreshList();
        }
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [selected, reload, acceptSnapshot, refreshList]);
  useEffect(() => {
    // 只有用户仍在追尾时才自动滚动；向上阅读后由“回到底部”按钮重新启用。
    if (snapshot && stickBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 草稿改变后重新测量 textarea 的实际高度。
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`;
    }
  }, [draft]);
  useEffect(() => {
    let disposed = false;
    setBoundProject(null);
    if (snapshot?.session.workspaceId)
      void client
        .execution(snapshot.session.id)
        .then((value) => {
          if (!disposed) setBoundProject(value.workspace);
        })
        .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [snapshot?.session.id, snapshot?.session.workspaceId]);
  function openTools() {
    setToolsOpen(true);
  }
  async function openSettings() {
    try {
      setSettings(await client.settings());
      setSettingsOpen(true);
    } catch (reason) {
      setError(errorText(reason));
    }
  }
  function choose(id: string | null) {
    projectChoice.current++;
    setPreparingProject(false);
    setSelected(id);
    if (!id) {
      setDraftProject(null);
      createRequest.current = null;
    }
    setSidebarOpen(false);
    setProjectPickerOpen(false);
  }
  async function selectRecentProject(project: Workspace) {
    choose(null);
    const choice = projectChoice.current;
    setPreparingProject(true);
    try {
      // 侧栏与输入区菜单共用目录准备入口，不能把缓存中的旧身份直接用于 MCP 设置。
      const next = await client.prepareProject(project.path);
      if (choice !== projectChoice.current) return;
      setDraftProject(next);
      setWorkspaces((old) => [next, ...old.filter((p) => p.id !== next.id)]);
    } catch (reason) {
      if (choice === projectChoice.current) setError(errorText(reason));
    } finally {
      if (choice === projectChoice.current) setPreparingProject(false);
    }
  }
  function openDocument(path: string) {
    const project = boundProject ?? draftProject;
    if (!project) {
      setError("请先选择项目，再打开文档。");
      return;
    }
    setDocumentsOpen(true);
    setDocumentRequest({ workspaceId: project.id, path, nonce: Date.now() });
  }
  function quoteDocument(quote: DocumentQuote) {
    const next = [...fragments, { ...quote, id: crypto.randomUUID() }];
    if ([draft, fragmentContext(next)].join("\n\n").length > 8000) {
      setError("选段与输入合计超过 8000 字符，请缩小选区后再添加。");
      return;
    }
    setFragmentDrafts((old) => ({
      ...old,
      [draftKey]: [
        ...(old[draftKey] ?? []),
        next[next.length - 1] as SelectedFragment,
      ],
    }));
    if (window.innerWidth < 1100) setDocumentsOpen(false);
    requestAnimationFrame(() => textarea.current?.focus());
  }
  function updateDraft(value: string) {
    setDrafts((old) => ({ ...old, [draftKey]: value }));
  }
  // 发送与重新生成共用并发门禁；重新生成不提交新问题，也不消耗输入框里正在编辑的草稿。
  async function send(
    kind: "send" | "regenerate" = "send",
    confirmSideEffects = false,
  ) {
    if (
      submitting ||
      preparingProject ||
      busy ||
      loading ||
      (kind === "send" && !draft.trim())
    )
      return;
    if (!settings?.configured) {
      setSettingsOpen(true);
      return;
    }
    if (kind === "regenerate" && latestHasEffects && !confirmSideEffects) {
      setConfirmRerun(true);
      return;
    }
    setSubmitting(true);
    setError("");
    stickBottom.current = true;
    const typedText = draft.trim();
    const sentFragments = fragments;
    const text = [typedText, fragmentContext(sentFragments)]
      .filter(Boolean)
      .join("\n\n");
    if (kind === "send" && text.length > 8000) {
      setSubmitting(false);
      setError("问题和选段合计超过 8000 字符，请移除部分片段或缩短问题。");
      return;
    }
    const skillIds = skillDrafts[draftKey] ?? [];
    let sourceKey = draftKey;
    let id = selected;
    try {
      let revision = snapshot?.session.revision ?? 0;
      if (!id) {
        createRequest.current ??= crypto.randomUUID();
        const session = await client.createSession({
          requestId: createRequest.current,
          ...(draftProject ? { path: draftProject.path } : {}),
        });
        createRequest.current = null;
        id = session.id;
        sourceKey = session.id;
        setDrafts((old) => ({ ...old, [session.id]: old.new ?? "", new: "" }));
        setFragmentDrafts((old) => ({
          ...old,
          [session.id]: old.new ?? [],
          new: [],
        }));
        setSkillDrafts((old) => ({
          ...old,
          [session.id]: old.new ?? [],
          new: [],
        }));
        revision = session.revision;
        selectedRef.current = id;
        setSelected(id);
        setSessions((old) => [session, ...old]);
      }
      // 若上次网络结果不确定且操作内容一致，复用完整原命令（包括旧版本号），让服务端幂等命中。
      const previous = pending.current.get(id);
      const same =
        previous?.kind === kind &&
        (previous.input.executionMode ?? "standard") === executionMode &&
        (kind === "regenerate" ||
          ("content" in previous.input &&
            previous.input.content === text &&
            JSON.stringify(previous.input.skillIds ?? []) ===
              JSON.stringify(skillIds)));
      const input =
        same && previous
          ? previous.input
          : {
              requestId: crypto.randomUUID(),
              expectedRevision: revision,
              executionMode,
              ...(kind === "send"
                ? { content: text, skillIds }
                : { confirmSideEffects }),
            };
      pending.current.set(id, { kind, input });
      const accepted =
        kind === "send"
          ? await client.send(id, input as RunInput)
          : await client.regenerate(id, input);
      pending.current.delete(id);
      acceptSnapshot(accepted.snapshot);
      if (kind === "send")
        setSkillDrafts((old) => ({
          ...old,
          [sourceKey]:
            JSON.stringify(old[sourceKey] ?? []) === JSON.stringify(skillIds)
              ? []
              : (old[sourceKey] ?? []),
        }));
      // 只清除与本次已接受问题一致的草稿；请求期间用户继续输入的内容必须保留。
      if (kind === "send")
        setDrafts((old) => ({
          ...old,
          [sourceKey]:
            old[sourceKey]?.trim() === typedText ? "" : (old[sourceKey] ?? ""),
        }));
      if (kind === "send")
        setFragmentDrafts((old) => ({
          ...old,
          [sourceKey]: (old[sourceKey] ?? []).filter(
            (f) => !sentFragments.some((sent) => sent.id === f.id),
          ),
        }));
      await refreshList();
    } catch (reason) {
      if (
        reason instanceof ApiError &&
        reason.code === "side_effect_confirmation"
      )
        setConfirmRerun(true);
      else if (!id || selectedRef.current === id) setError(errorText(reason));
      // 明确的 HTTP 错误可释放待提交标识；status=0 的网络错误不知服务端是否落库，保留原命令。
      if (id && reason instanceof ApiError && reason.status !== 0)
        pending.current.delete(id);
      // 补读是后台校正；连接异常时不能让第二次 GET 永久占住提交门禁。
      // acceptSnapshot 按当前会话/cursor 拒绝迟到结果，原命令仍由 pending 保证幂等。
      if (id)
        void client
          .session(id)
          .then(acceptSnapshot)
          .catch(() => {});
    } finally {
      setSubmitting(false);
    }
  }
  // 等待后端取消并提交终态，再读取快照；不只在浏览器把“生成中”按钮隐藏。
  async function stop() {
    if (!snapshot?.activeRun) return;
    try {
      await client.cancel(snapshot.activeRun.id);
      acceptSnapshot(await client.session(snapshot.session.id));
    } catch (reason) {
      setError(errorText(reason));
    }
  }
  async function manageSession() {
    if (!manage) return;
    setManageBusy(true);
    setError("");
    try {
      if (manage.kind === "delete") {
        await client.delete(manage.session.id);
        if (selected === manage.session.id) choose(null);
        setFragmentDrafts((old) => {
          const next = { ...old };
          delete next[manage.session.id];
          return next;
        });
        setDrafts((old) => {
          const next = { ...old };
          delete next[manage.session.id];
          return next;
        });
      } else {
        // 重命名前重新读取版本；真正的并发冲突仍由服务端判断，避免覆盖其他页面的修改。
        const fresh = await client.session(manage.session.id);
        await client.rename(manage.session.id, title, fresh.session.revision);
        if (selected === manage.session.id)
          acceptSnapshot(await client.session(manage.session.id));
      }
      setManage(null);
      await refreshList();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setManageBusy(false);
    }
  }
  const latest = snapshot?.latestRun;
  const latestHasEffects = (snapshot?.steps ?? [])
    .filter(
      (step) =>
        step.runId === latest?.id ||
        snapshot?.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.runId === step.runId &&
            snapshot.messages.at(-1)?.id === message.id,
        ),
    )
    .some((step) => step.tools.some((tool) => tool.result?.effectsPossible));
  return (
    <DocumentNavigation.Provider value={openDocument}>
      <SettingsNavigation.Provider
        value={(page) => {
          setSettingsOpen(page === "模型设置");
          setSkillsOpen(page === "技能");
          setToolsOpen(page === "MCP 服务");
          setPluginsOpen(page === "插件");
          setHooksOpen(page === "Hook");
          setMemoryOpen(page === "长期记忆");
          setCommandSettingsOpen(page === "命令权限");
        }}
      >
        <div
          className={`app-shell ${documentsOpen ? "has-documents" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
        >
          {sidebarOpen && (
            <button
              type="button"
              aria-label="关闭会话列表"
              className="sidebar-shade"
              onClick={() => setSidebarOpen(false)}
            />
          )}
          <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
            <div className="brand">
              <Bot size={22} strokeWidth={1.7} />
              <strong>MyAgent</strong>
              <button
                type="button"
                className="icon-button desktop-collapse"
                aria-label="收起侧栏"
                onClick={() => setSidebarCollapsed(true)}
              >
                <PanelLeftClose size={17} />
              </button>
              <button
                type="button"
                className="icon-button mobile-only"
                aria-label="收起侧栏"
                onClick={() => setSidebarOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <button
              className="new-chat"
              type="button"
              onClick={() => choose(null)}
            >
              <SquarePen size={17} />
              开启新对话
            </button>
            <div className="sidebar-label">
              项目
              <button
                type="button"
                className="icon-button"
                aria-label="选择项目目录"
                onClick={() => {
                  choose(null);
                  setProjectPickerOpen(true);
                }}
              >
                <Plus size={14} />
              </button>
            </div>
            <SessionNavigation
              sessions={sessions}
              workspaces={workspaces}
              selected={selected}
              onSelect={choose}
              onCreate={(project) =>
                project ? void selectRecentProject(project) : choose(null)
              }
              onRename={(session) => {
                setTitle(session.title);
                setManage({ kind: "rename", session });
              }}
              onDelete={(session) => setManage({ kind: "delete", session })}
            />
            <div className="sidebar-bottom">
              <button
                className="settings-link"
                type="button"
                onClick={() => setObservationOpen({})}
              >
                <Activity size={17} />
                执行记录与用量
              </button>
              <button
                className="settings-link"
                type="button"
                aria-label="插件设置"
                onClick={() => {
                  setPluginsOpen(true);
                  setSidebarOpen(false);
                }}
              >
                <Plug size={17} />
                <span>插件</span>
              </button>
              <button
                className="settings-link"
                type="button"
                aria-label="Hook 设置"
                onClick={() => {
                  setHooksOpen(true);
                  setSidebarOpen(false);
                }}
              >
                <Settings2 size={17} />
                <span>Hook</span>
              </button>
              <button
                className="settings-link"
                type="button"
                aria-label="技能设置"
                onClick={() => {
                  setSkillsOpen(true);
                  setSidebarOpen(false);
                }}
              >
                <FileText size={17} />
                <span>技能</span>
              </button>
              <button
                className="settings-link"
                type="button"
                onClick={() => {
                  setMemoryOpen(true);
                  setSidebarOpen(false);
                }}
              >
                <Settings2 size={17} />
                <span>长期记忆</span>
              </button>
              <button
                className="settings-link"
                type="button"
                onClick={() => {
                  setCommandSettingsOpen(true);
                  setSidebarOpen(false);
                }}
              >
                <ShieldCheck size={17} />
                <span>命令权限</span>
              </button>
              <button
                className="settings-link"
                type="button"
                onClick={() => void openTools()}
              >
                <Plug size={17} />
                <span>MCP 服务</span>
              </button>
              <button
                className="settings-link"
                type="button"
                onClick={() => void openSettings()}
              >
                <Settings2 size={17} />
                <span>模型设置</span>
                <span
                  className={`status-light ${settings?.configured ? "ready" : ""}`}
                />
              </button>
              <div className="privacy">
                <ShieldCheck size={14} />
                <span>历史记录保存在本机</span>
              </div>
            </div>
          </aside>
          <main
            className={`workspace ${!loading && messages.length === 0 ? "empty-workspace" : ""}`}
          >
            <header className="workspace-header">
              <div className="header-left">
                <button
                  type="button"
                  className="icon-button mobile-only"
                  aria-label="打开会话列表"
                  onClick={() => setSidebarOpen(true)}
                >
                  <Menu size={21} />
                </button>
                {sidebarCollapsed && (
                  <button
                    type="button"
                    className="icon-button desktop-expand"
                    aria-label="展开侧栏"
                    onClick={() => setSidebarCollapsed(false)}
                  >
                    <PanelLeftOpen size={19} />
                  </button>
                )}
                <span className="thread-title">
                  {snapshot?.session.title ?? "新对话"}
                </span>
              </div>
              <span
                className="workspace-badge"
                title={
                  boundProject?.path ??
                  draftProject?.path ??
                  "新对话使用独立目录"
                }
              >
                <Folder size={13} />
                {boundProject?.name ?? draftProject?.name ?? "默认项目"}
              </span>
              <button
                type="button"
                className="team-toggle"
                aria-label="打开项目文档"
                aria-expanded={documentsOpen}
                onClick={() => setDocumentsOpen((v) => !v)}
              >
                <FileText size={16} />
                <span>文档</span>
              </button>
              {snapshot && teamCount > 0 && (
                <button
                  type="button"
                  className="team-toggle"
                  aria-label="切换团队侧栏"
                  aria-expanded={teamOpen}
                  onClick={() => {
                    setTeamOpen((v) => !v);
                    setDocumentsOpen(false);
                  }}
                >
                  <PanelRight size={16} />
                  <span>团队{teamCount ? ` · ${teamCount}` : ""}</span>
                </button>
              )}
            </header>
            <div
              className="conversation"
              ref={scroll}
              onScroll={() => {
                const element = scroll.current;
                if (!element) return;
                const near =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  90;
                stickBottom.current = near;
                setShowBottom(!near);
              }}
            >
              {loading ? (
                <div className="loading-state">
                  <LoaderCircle className="spin" size={22} />
                  正在加载对话…
                </div>
              ) : messages.length === 0 ? (
                <div className="welcome">
                  <Bot size={38} strokeWidth={1.4} />
                  <h1>想做点什么？</h1>
                  <p className="welcome-description">
                    {draftProject?.name ?? "从一个问题，或一个项目开始"}
                  </p>
                  {!settings?.configured && (
                    <button
                      type="button"
                      className="setup-prompt"
                      onClick={() => void openSettings()}
                    >
                      <Settings2 size={15} />
                      首次使用，先连接你的模型
                      <ArrowUp size={14} />
                    </button>
                  )}
                </div>
              ) : (
                <div className="message-list">
                  {messages.map((message) => (
                    <article
                      key={message.id}
                      className={`message ${message.role}`}
                      aria-label={
                        message.role === "user" ? "你的消息" : "模型回答"
                      }
                    >
                      <div className="message-body">
                        {message.role === "assistant" && selected && (
                          <HookProcess
                            client={client}
                            sessionId={selected}
                            runId={message.runId}
                            cursor={hookCursor}
                          />
                        )}
                        {message.status === "generating" && (
                          <span className="generating-label" role="status">
                            <span />
                            {snapshot?.activeRun?.status === "waiting_context"
                              ? "等待整理上下文"
                              : snapshot?.activeRun?.status ===
                                  "waiting_approval"
                                ? "等待批准"
                                : snapshot?.activeRun?.status ===
                                    "waiting_reconciliation"
                                  ? "等待核对"
                                  : snapshot?.activeRun?.status ===
                                      "recoverable"
                                    ? "等待恢复"
                                    : snapshot?.activeRun?.status ===
                                        "waiting_agents"
                                      ? "正在收集成员结果"
                                      : snapshot?.activeRun?.status ===
                                          "cleaning"
                                        ? "正在完成收尾"
                                        : (snapshot?.steps ?? []).some(
                                              (step) =>
                                                step.runId === message.runId &&
                                                step.status === "tools",
                                            )
                                          ? "正在执行工具"
                                          : "正在生成"}
                          </span>
                        )}
                        {message.role === "assistant" && (
                          <RunProcess
                            active={message.status === "generating"}
                            client={client}
                            sessionId={snapshot?.session.id ?? ""}
                            steps={(snapshot?.steps ?? []).filter(
                              (step) => step.runId === message.runId,
                            )}
                          />
                        )}
                        {message.role === "user" ? (
                          <div className="user-text">{message.content}</div>
                        ) : message.content ? (
                          <Markdown content={message.content} />
                        ) : message.status === "generating" ? (
                          <div className="thinking-dots">
                            <span />
                            <span />
                            <span />
                          </div>
                        ) : (
                          <p className="muted">这次没有生成完整回答。</p>
                        )}
                        {message.role === "assistant" && (
                          <RunObservation
                            client={client}
                            runId={message.runId}
                            active={message.status === "generating"}
                            refreshKey={observationRefresh}
                            onOpen={() =>
                              setObservationOpen({ runId: message.runId })
                            }
                          />
                        )}
                        {["cancelled", "interrupted", "failed"].includes(
                          message.status,
                        ) && (
                          <p className="message-status">
                            {message.status === "cancelled"
                              ? "已停止生成"
                              : message.status === "interrupted"
                                ? "生成已中断"
                                : "生成失败"}
                          </p>
                        )}
                        {message.content && message.status !== "generating" && (
                          <div className="message-tools">
                            {message.role === "user" && (
                              <time dateTime={message.createdAt}>
                                {new Date(message.createdAt).toLocaleString(
                                  "zh-CN",
                                  {
                                    month: "2-digit",
                                    day: "2-digit",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    hour12: false,
                                  },
                                )}
                              </time>
                            )}
                            <CopyButton
                              text={() => message.content}
                              label="复制消息"
                              iconOnly
                            />
                            {message.role === "assistant" &&
                              message.replyToId === latest?.userMessageId && (
                                <button
                                  type="button"
                                  className="copy-button"
                                  disabled={busy || submitting}
                                  title="重新生成可能再次调用工具"
                                  onClick={() => void send("regenerate")}
                                >
                                  <RefreshCw size={14} />
                                  {latestHasEffects
                                    ? "重新运行任务"
                                    : "重新生成"}
                                </button>
                              )}
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                  {latest?.contextTrimmed && (
                    <p className="context-note">
                      <CircleHelp size={14} />
                      部分上下文使用摘要或有界结果预览；已保存的历史仍可查阅。
                    </p>
                  )}
                  {latest?.finishReason === "length" && (
                    <p className="context-note">
                      回答达到模型输出上限，可重新生成或继续提问。
                    </p>
                  )}
                  {latest?.error && !busy && (
                    <div className="run-error" role="status">
                      <span>{latest.error.message}</span>
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => void send("regenerate")}
                      >
                        <RefreshCw size={14} />
                        重试回答
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="composer-area">
              {snapshot && (
                <ExecutionPanel
                  key={snapshot.session.id}
                  client={client}
                  snapshot={snapshot}
                  onRefresh={() => setReload((value) => value + 1)}
                />
              )}
              {!loading && messages.length === 0 && (
                <div className="suggestions">
                  {suggestions.map((suggestion, index) => (
                    <button
                      type="button"
                      key={suggestion}
                      onClick={() => {
                        updateDraft(suggestion);
                        textarea.current?.focus();
                      }}
                    >
                      {index === 0 ? (
                        <FolderOpen size={18} />
                      ) : index === 1 ? (
                        <Code2 size={18} />
                      ) : (
                        <FileText size={18} />
                      )}
                      <span>{suggestion}</span>
                    </button>
                  ))}
                </div>
              )}
              {showBottom && (
                <button
                  type="button"
                  className="scroll-bottom icon-button"
                  aria-label="回到底部"
                  onClick={() => {
                    stickBottom.current = true;
                    if (scroll.current)
                      scroll.current.scrollTop = scroll.current.scrollHeight;
                    setShowBottom(false);
                  }}
                >
                  <ArrowDown size={18} />
                </button>
              )}
              {connection === "reconnecting" && selected && (
                <div className="connection-note">
                  <LoaderCircle className="spin" size={13} />
                  正在重新连接本地服务…
                  <button
                    type="button"
                    onClick={() => setReload((value) => value + 1)}
                  >
                    重新加载
                  </button>
                </div>
              )}
              {error && (
                <div className="notice error composer-error" role="alert">
                  <span>{error}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="关闭错误提示"
                    onClick={() => setError("")}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <form
                className={`composer ${busy ? "working" : ""}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <SelectedFragments
                  key={draftKey}
                  fragments={fragments}
                  onRemove={(id) =>
                    setFragmentDrafts((old) => ({
                      ...old,
                      [draftKey]: (old[draftKey] ?? []).filter(
                        (f) => f.id !== id,
                      ),
                    }))
                  }
                />
                <SkillPicker
                  client={client}
                  workspaceId={
                    snapshot?.session.workspaceId ?? draftProject?.id
                  }
                  selected={skillDrafts[draftKey] ?? []}
                  onChange={(ids) =>
                    setSkillDrafts((old) => ({ ...old, [draftKey]: ids }))
                  }
                  draft={draft}
                  onComplete={(name) => {
                    updateDraft(draft.replace(/\$[a-z0-9-]*$/, `$${name} `));
                    textarea.current?.focus();
                  }}
                />
                <textarea
                  ref={textarea}
                  value={draft}
                  onChange={(event) => updateDraft(event.target.value)}
                  placeholder={
                    busy ? "先写下你的下一个问题…" : "描述任务，或问一个问题…"
                  }
                  aria-label="输入消息"
                  rows={1}
                  maxLength={8000}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                  onKeyDown={(event) => {
                    // Enter 只有在输入法组合结束后才发送；同时检查组合状态、原生标记与兼容 keyCode 229。
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !composing.current &&
                      !event.nativeEvent.isComposing &&
                      event.nativeEvent.keyCode !== 229
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <button
                    type="button"
                    className="composer-model"
                    aria-label="选择模型"
                    onClick={() => void openSettings()}
                  >
                    <span>{settings?.model || "连接模型"}</span>
                    <ChevronDown size={13} />
                  </button>
                  <span className="composer-hint">
                    {draft.length + fragmentContext(fragments).length > 7000
                      ? `${draft.length + fragmentContext(fragments).length} / 8000`
                      : "Shift + Enter 换行"}
                  </span>
                  {busy ? (
                    <button
                      type="button"
                      className="send-button stop"
                      aria-label="停止生成"
                      onClick={() => void stop()}
                    >
                      <Square size={15} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="send-button"
                      aria-label="发送消息"
                      disabled={
                        !draft.trim() ||
                        submitting ||
                        preparingProject ||
                        loading
                      }
                    >
                      {submitting ? (
                        <LoaderCircle className="spin" size={19} />
                      ) : (
                        <ArrowUp size={21} />
                      )}
                    </button>
                  )}
                </div>
              </form>
              <div className="project-control">
                {snapshot && (
                  <ContextPanel
                    key={snapshot.session.id}
                    client={client}
                    snapshot={snapshot}
                    onRefresh={() => setReload((value) => value + 1)}
                  />
                )}

                <label
                  className={`execution-mode ${(busy ? snapshot?.activeRun?.executionMode : executionMode) === "full_access" ? "unrestricted" : ""}`}
                >
                  <ShieldCheck size={15} />
                  <select
                    aria-label="执行权限"
                    disabled={busy || submitting || loading}
                    value={
                      busy
                        ? (snapshot?.activeRun?.executionMode ?? "standard")
                        : executionMode
                    }
                    onChange={(event) => {
                      const mode = event.target.value as ExecutionMode;
                      setExecutionMode(mode);
                      try {
                        localStorage.setItem("myagent.execution-mode", mode);
                      } catch {
                        /* 禁用存储时仍可在当前页面选择。 */
                      }
                    }}
                  >
                    <option value="standard">标准权限</option>
                    <option value="full_access">完全访问</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="project-selector"
                  aria-label={selected ? "项目权限" : "选择项目"}
                  aria-expanded={projectPickerOpen}
                  aria-haspopup="dialog"
                  disabled={submitting || preparingProject || loading}
                  title={
                    boundProject?.path ??
                    draftProject?.path ??
                    "不选择时，为新对话自动创建独立目录"
                  }
                  onClick={() =>
                    selected
                      ? setProjectPermissionsOpen(true)
                      : setProjectPickerOpen((value) => !value)
                  }
                >
                  {preparingProject ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Folder size={16} />
                  )}
                  <span>
                    {selected
                      ? (boundProject?.name ?? "默认项目")
                      : (draftProject?.name ?? "选择项目")}
                  </span>
                  <ChevronDown size={13} />
                </button>
                {projectPickerOpen && (
                  <ProjectPicker
                    client={client}
                    selected={draftProject}
                    onSelect={(project) => {
                      setDraftProject(project);
                      createRequest.current = null;
                      if (project)
                        setWorkspaces((old) => [
                          project,
                          ...old.filter((p) => p.id !== project.id),
                        ]);
                    }}
                    onClose={() => setProjectPickerOpen(false)}
                  />
                )}
              </div>
              {(busy ? snapshot?.activeRun?.executionMode : executionMode) ===
                "full_access" && (
                <p className="execution-mode-note">
                  {busy ? "本轮完全访问" : "下次任务完全访问"}
                  ：不审批、不使用沙箱，可访问本机文件与网络。主 Agent
                  和成员均适用。
                </p>
              )}
              <p className="composer-footnote">
                <span>
                  <ShieldCheck size={12} /> 本地运行
                </span>
                <span>AI 的回答可能不准确，请核对重要信息。</span>
              </p>
            </div>
          </main>
          {(documentsOpen || documentsMounted) && (
            <Suspense
              fallback={
                <aside className="document-loading">正在打开文档工作区…</aside>
              }
            >
              <DocumentWorkbench
                client={client}
                workspace={boundProject ?? draftProject}
                open={documentsOpen}
                request={documentRequest}
                onClose={() => setDocumentsOpen(false)}
                onQuote={quoteDocument}
              />
            </Suspense>
          )}
          {snapshot && (
            <TeamPanel
              key={snapshot.session.id}
              client={client}
              snapshot={snapshot}
              open={teamOpen && !documentsOpen}
              onClose={() => setTeamOpen(false)}
              onCount={setTeamCount}
              onRefresh={() => setReload((value) => value + 1)}
            />
          )}

          {projectPermissionsOpen && boundProject && (
            <ProjectPermissions
              client={client}
              workspace={boundProject}
              onClose={() => setProjectPermissionsOpen(false)}
            />
          )}
          {commandSettingsOpen && (
            <CommandSettingsDialog
              client={client}
              {...((boundProject ?? draftProject)?.id
                ? {
                    initialWorkspaceId: (boundProject ?? draftProject)
                      ?.id as string,
                  }
                : {})}
              onClose={() => setCommandSettingsOpen(false)}
            />
          )}
          {observationOpen && (
            <ObservabilityDialog
              client={client}
              {...observationOpen}
              onClose={() => {
                setObservationOpen(null);
                const url = new URL(location.href);
                url.searchParams.delete("view");
                history.replaceState({}, "", url);
                setObservationRefresh((v) => v + 1);
              }}
            />
          )}
          {memoryOpen && (
            <MemoryDialog
              client={client}
              {...(selected ? { sessionId: selected } : {})}
              onClose={() => setMemoryOpen(false)}
            />
          )}
          {toolsOpen && (
            <ToolSettingsDialog
              client={client}
              {...((boundProject ?? draftProject)?.id
                ? {
                    initialWorkspaceId: (boundProject ?? draftProject)
                      ?.id as string,
                  }
                : {})}
              onClose={() => setToolsOpen(false)}
            />
          )}
          {confirmRerun && (
            <Modal title="重新运行任务" onClose={() => setConfirmRerun(false)}>
              <p>
                上一轮可能修改了文件或外部系统。重新运行会基于当前实际状态再次执行，原来的修改不会自动撤销，工具可能再次产生副作用。
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setConfirmRerun(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    setConfirmRerun(false);
                    void send("regenerate", true);
                  }}
                >
                  确认重新运行
                </button>
              </div>
            </Modal>
          )}
          {pluginsOpen && (
            <PluginsDialog
              client={client}
              workspaceId={snapshot?.session.workspaceId ?? draftProject?.id}
              onClose={() => setPluginsOpen(false)}
            />
          )}
          {hooksOpen && (
            <HooksDialog
              client={client}
              workspaceId={snapshot?.session.workspaceId ?? draftProject?.id}
              onClose={() => setHooksOpen(false)}
            />
          )}
          {skillsOpen && (
            <SkillsDialog
              client={client}
              workspaceId={snapshot?.session.workspaceId ?? draftProject?.id}
              onClose={() => setSkillsOpen(false)}
            />
          )}
          {settingsOpen && settings && (
            <SettingsDialog
              client={client}
              settings={settings}
              onChange={setSettings}
              onClose={() => setSettingsOpen(false)}
            />
          )}
          {settingsOpen && !settings && (
            <Modal title="连接本地服务" onClose={() => setSettingsOpen(false)}>
              <p>暂时无法读取模型设置，请确认本地服务已启动。</p>
              <button
                type="button"
                className="button primary"
                onClick={() => location.reload()}
              >
                重新加载
              </button>
            </Modal>
          )}
          {manage && (
            <Modal
              title={manage.kind === "rename" ? "重命名对话" : "删除对话"}
              onClose={() => setManage(null)}
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void manageSession();
                }}
              >
                {manage.kind === "rename" ? (
                  <label>
                    对话标题
                    <input
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      maxLength={100}
                      required
                    />
                  </label>
                ) : (
                  <p>
                    确定删除「{manage.session.title}
                    」吗？这会删除本机的全部相关消息；正在生成的回答会先停止。项目目录及其中的文件会保留。
                  </p>
                )}
                {error && (
                  <div className="notice error" role="alert">
                    {error}
                  </div>
                )}
                <div className="modal-actions">
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setManage(null)}
                  >
                    取消
                  </button>
                  <button
                    className={`button ${manage.kind === "delete" ? "danger-button" : "primary"}`}
                    type="submit"
                    disabled={
                      manageBusy || (manage.kind === "rename" && !title.trim())
                    }
                  >
                    {manageBusy ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Check size={16} />
                    )}
                    {manage.kind === "rename" ? "保存名称" : "删除对话"}
                  </button>
                </div>
              </form>
            </Modal>
          )}
        </div>
      </SettingsNavigation.Provider>
    </DocumentNavigation.Provider>
  );
}
