/** 技能设置：独立于会话查询来源和版本，只读查看正文；轮询不会覆盖目录输入，移除不删除源文件。 */
import type {
  ChatClient,
  SkillCatalog,
  SkillEntry,
  Workspace,
} from "@myagent/sdk";
import { BookOpen, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../../components/Modal.js";
import { Markdown } from "../chat/Markdown.js";
export function SkillsDialog({
  client,
  workspaceId,
  onClose,
}: {
  client: ChatClient;
  workspaceId?: string | undefined;
  onClose: () => void;
}) {
  const generation = useRef(0);
  const sourcesPanel = useRef<HTMLDetailsElement>(null);

  const [project, setProject] = useState(workspaceId ?? ""),
    [projects, setProjects] = useState<Workspace[]>([]);
  const [view, setView] = useState<SkillCatalog>({ sources: [], entries: [] }),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState("");
  const [path, setPath] = useState(""),
    [scope, setScope] = useState<"user" | "project">("user"),
    [error, setError] = useState("");
  const [detail, setDetail] = useState<{
      entry: SkillEntry;
      body: string;
      resources: { path: string; bytes: number }[];
    } | null>(null),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    void client
      .workspaces()
      .then((r) => {
        if (alive) setProjects(r.workspaces);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [client]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision 是用户手动重扫和保存成功后的失效序号。
  useEffect(() => {
    let alive = true,
      loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const started = generation.current;
        const value = await client.skills(project || undefined);
        if (alive && started === generation.current) setView(value);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "技能查询失败");
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, project, revision]);
  async function action(fn: () => Promise<unknown>) {
    generation.current++;
    setBusy(true);
    setError("");
    try {
      await fn();
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      generation.current++;
      setRevision((v) => v + 1);
      setBusy(false);
    }
  }
  const visibleEntries = view.entries.filter(
    (entry) =>
      (filter === "all" || entry.scope === filter) &&
      `${entry.name} ${entry.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const openSources = () => {
    if (sourcesPanel.current) {
      sourcesPanel.current.open = true;
      sourcesPanel.current.querySelector("input")?.focus();
    }
  };
  return (
    <Modal title="技能" onClose={onClose} wide dirty={Boolean(path.trim())}>
      <div className="catalog-heading">
        <span>
          {view.entries.length} 个技能{" "}
          <span className="muted">
            ·{" "}
            {
              view.entries.filter((entry) => entry.enabled && !entry.error)
                .length
            }{" "}
            个已启用
          </span>
        </span>
        <button type="button" className="button primary" onClick={openSources}>
          <Plus size={15} />
          添加技能
        </button>
      </div>
      <p className="field-hint">
        技能提供完成任务的方法。新增、修改及启停从下一轮任务生效，脚本仍受命令权限和沙箱约束。
      </p>
      <div className="skill-toolbar">
        <label>
          当前项目
          <select
            aria-label="技能项目"
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setDetail(null);
            }}
          >
            <option value="">仅用户级</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.path}
              </option>
            ))}
          </select>
        </label>
        <label>
          范围
          <select
            aria-label="技能范围"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部</option>
            <option value="user">用户级</option>
            <option value="project">项目级</option>
          </select>
        </label>
        <label>
          查找
          <input
            aria-label="搜索技能"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="名称或用途"
          />
        </label>
        <button type="button" onClick={() => setRevision((v) => v + 1)}>
          重新扫描
        </button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <details className="catalog-sources" ref={sourcesPanel}>
        <summary>来源目录 · {view.sources.length}</summary>
        {view.sources.map((source) => (
          <div className="skill-source" key={source.id}>
            <code>{source.path}</code>
            <span>{source.scope === "user" ? "用户级" : "项目级"}</span>
            {source.plugin && <span>由插件 {source.plugin.name} 管理</span>}
            {!source.builtin && !source.plugin && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      client.changeSkillSource(source.id, {
                        expectedRevision: source.revision,
                        enabled: !source.enabled,
                      }),
                    )
                  }
                >
                  {source.enabled ? "停用来源" : "启用来源"}
                </button>
                <button
                  type="button"
                  disabled={busy || (!project && source.scope === "user")}
                  onClick={() =>
                    void action(() =>
                      client.changeSkillSource(source.id, {
                        expectedRevision: source.revision,
                        scope: source.scope === "user" ? "project" : "user",
                        ...(source.scope === "user"
                          ? { workspaceId: project }
                          : {}),
                      }),
                    )
                  }
                >
                  {source.scope === "user" ? "改为当前项目级" : "改为用户级"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void action(() => client.removeSkillSource(source.id))
                  }
                >
                  移除来源
                </button>
              </>
            )}
          </div>
        ))}
        <p className="field-hint">
          添加目录不会移动文件；移除来源不会删除文件。
        </p>
        <form
          className="skill-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await client.addSkillSource({
                path,
                scope,
                ...(scope === "project" ? { workspaceId: project } : {}),
              });
              setPath("");
            });
          }}
        >
          <label>
            目录
            <input
              aria-label="技能来源路径"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="后端所在机器的目录"
              required
            />
          </label>
          <label>
            作用域
            <select
              aria-label="新增技能作用域"
              value={scope}
              onChange={(e) => setScope(e.target.value as "user" | "project")}
            >
              <option value="user">用户级</option>
              <option value="project" disabled={!project}>
                项目级
              </option>
            </select>
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const result = await client.pickDirectory();
                if (result.status === "selected") setPath(result.path ?? "");
                else if (result.status === "unavailable")
                  setError("系统目录窗口不可用，请输入目录路径。");
              })
            }
          >
            选择目录
          </button>
          <button
            type="submit"
            disabled={busy || !path.trim() || (scope === "project" && !project)}
          >
            添加来源
          </button>
        </form>
      </details>
      <div className={`skill-browser ${detail ? "has-detail" : ""}`}>
        <div className="skill-list">
          {visibleEntries.map((entry) => (
            <article
              className="skill-card"
              key={entry.id}
              data-selected={detail?.entry.id === entry.id}
            >
              <div className="skill-card-heading">
                <button
                  type="button"
                  onClick={() =>
                    void action(async () =>
                      setDetail(
                        await client.skill(entry.id, project || undefined),
                      ),
                    )
                  }
                >
                  <BookOpen size={16} />
                  {entry.displayName ?? entry.name}
                </button>
                <span>
                  {entry.scope === "project" ? "项目级" : "用户级"}
                  {entry.implicit ? " · 按需选择" : " · 仅明确选择"}
                  {entry.plugin &&
                    ` · 插件 ${entry.plugin.name}（在插件页管理）`}
                </span>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`启用技能 ${entry.name}`}
                    checked={entry.enabled && !entry.error}
                    disabled={busy || !!entry.error || !!entry.plugin}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setView((old) => ({
                        ...old,
                        entries: old.entries.map((item) =>
                          item.id === entry.id ? { ...item, enabled } : item,
                        ),
                      }));
                      void action(() =>
                        client.setSkillEnabled(
                          entry.id,
                          enabled,
                          project || undefined,
                        ),
                      );
                    }}
                  />
                  启用
                </label>
              </div>
              <p>{entry.error ?? entry.description}</p>
              <small className="skill-path" title={entry.path}>
                {entry.path}
              </small>
            </article>
          ))}
        </div>
        {!visibleEntries.length && (
          <p className="empty-state">
            {view.entries.length
              ? "没有匹配的技能，试试其他名称或范围。"
              : "还没有技能。添加包含 SKILL.md 的目录，即可在对话中使用。"}
          </p>
        )}
        {detail && (
          <section className="skill-detail">
            <div className="skill-detail-heading">
              <h3>{detail.entry.name}</h3>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭技能详情"
                onClick={() => setDetail(null)}
              >
                <X size={16} />
              </button>
            </div>
            <p className="field-hint">
              {detail.entry.path} · 版本 {detail.entry.version.slice(0, 12)}
              {view.entries.find((e) => e.id === detail.entry.id)?.version !==
              detail.entry.version
                ? " · 文件已更新，请重新打开查看"
                : ""}
            </p>
            {detail.entry.compatibility && (
              <p>运行要求：{detail.entry.compatibility}</p>
            )}
            {detail.entry.dependencies && (
              <pre>依赖提示（不会自动安装）：{detail.entry.dependencies}</pre>
            )}
            <details>
              <summary>包内资源 · {detail.resources.length}</summary>
              {detail.resources.map((file) => (
                <p key={file.path}>
                  <code>{file.path}</code> · {file.bytes} 字节
                </p>
              ))}
            </details>
            <details>
              <summary>原始 SKILL.md</summary>
              <pre className="context-text">{detail.body}</pre>
            </details>
            <Markdown
              content={
                detail.body.replace(
                  /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
                  "",
                ) ||
                detail.entry.error ||
                "无法读取说明"
              }
            />
          </section>
        )}
      </div>
    </Modal>
  );
}
