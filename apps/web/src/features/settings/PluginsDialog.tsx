/** 插件管理页：安装预览和确认分开，作用域与编辑草稿不被轮询覆盖；页面不创建聊天或直接操作内核。 */
import type {
  ChatClient,
  PluginJob,
  PluginMutation,
  PluginSelection,
  PluginView,
  Workspace,
} from "@myagent/sdk";
import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal.js";

const jobLabel: Record<PluginJob["status"], string> = {
  preparing: "准备中",
  ready: "待确认",
  committed: "已提交",
  cancelled: "已取消",
  failed: "失败",
  interrupted: "已中断",
};
const label: Record<PluginView["status"], string> = {
  enabled: "已启用",
  disabled: "已禁用",
  installed: "已安装",
  configuration_required: "待配置",
  degraded: "部分不可用",
  pending_cleanup: "已移除，等待清理",
};
export function PluginsDialog({
  client,
  workspaceId,
  onClose,
}: {
  client: ChatClient;
  workspaceId?: string | undefined;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"user" | "project">(
      workspaceId ? "project" : "user",
    ),
    [project, setProject] = useState(workspaceId ?? ""),
    [projects, setProjects] = useState<Workspace[]>([]),
    [items, setItems] = useState<PluginView[]>([]);
  const [kind, setKind] = useState<"local" | "git">("local"),
    [path, setPath] = useState(""),
    [ref, setRef] = useState(""),
    [subdirectory, setSubdirectory] = useState(""),
    [enabled, setEnabled] = useState(true),
    [job, setJob] = useState<PluginJob | null>(null),
    [selected, setSelected] = useState<PluginView | null>(null);
  const [jobs, setJobs] = useState<PluginJob[]>([]);
  const [inspection, setInspection] = useState<PluginJob | null>(null);
  const [draft, setDraft] = useState<PluginSelection>({
      excluded: [],
      mcp: {},
    }),
    [token, setToken] = useState<Record<string, string>>({}),
    [environment, setEnvironment] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [filter, setFilter] = useState("");
  const target = {
    scope,
    ...(scope === "project" ? { workspaceId: project } : {}),
  };
  useEffect(() => {
    void client
      .workspaces()
      .then((v) =>
        setProjects(v.workspaces.filter((w) => w.kind !== "diagnostic")),
      )
      .catch((e) => setError(String(e)));
  }, [client]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh 是显式刷新；这里只替换列表，不覆盖编辑草稿。
  useEffect(() => {
    let active = true;
    if (scope === "project" && !project) {
      setItems([]);
      return;
    }
    const load = () =>
      void client
        .plugins({
          scope,
          ...(scope === "project" ? { workspaceId: project } : {}),
        })
        .then((v) => {
          if (active) setItems(v);
          void client
            .pluginJobs({
              scope,
              ...(scope === "project" ? { workspaceId: project } : {}),
            })
            .then((list) => {
              if (active) setJobs(list);
            })
            .catch(() => {});
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    load();
    const timer = setInterval(load, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, scope, project, refresh]);
  useEffect(() => {
    if (job?.status !== "preparing") return;
    let active = true;
    const timer = setInterval(() => {
      void client
        .pluginJob(job.id)
        .then((v) => {
          if (active) {
            setJob(v);
            if (v.manifest) setInspection(v);
            if (v.status === "failed" || v.status === "interrupted")
              setError(v.error ?? "准备失败");
          }
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    }, 500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, job?.id, job?.status]);
  const reset = () => {
    setJob(null);
    setInspection(null);
    setSelected(null);
    setDraft({ excluded: [], mcp: {} });
    setToken({});
    setEnvironment({});
    setError("");
  };
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  async function preview(
    action: PluginMutation["action"],
    item?: PluginView,
    chosen = draft,
  ) {
    await run(async () => {
      const current = action === "install" ? undefined : (item ?? selected);
      const source =
        action === "install"
          ? kind === "local"
            ? { kind: "local" as const, path }
            : {
                kind: "git" as const,
                url: path,
                ...(ref ? { ref } : {}),
                ...(subdirectory ? { subdirectory } : {}),
              }
          : undefined;
      const next = await client.previewPlugin({
        ...target,
        requestId: crypto.randomUUID(),
        expectedRevision: current?.revision ?? 0,
        action,
        ...(current ? { pluginId: current.pluginId } : {}),
        ...(source ? { source } : {}),
        enabled:
          action === "update" || action === "rollback"
            ? (current?.enabled ?? enabled)
            : enabled,
        selection: chosen,
      });
      setJob(next);
      if (next.manifest) setInspection(next);
    });
  }
  async function confirm() {
    if (!job?.confirmation) return;
    await run(async () => {
      const credentials: Record<
        string,
        { token?: string; environment?: Record<string, string> }
      > = {};
      for (const c of job.manifest?.components ?? []) {
        if (c.kind !== "mcp") continue;
        const env = environment[c.id];
        if (token[c.id] === undefined && env === undefined) continue;
        credentials[c.id] = {
          ...(token[c.id] !== undefined ? { token: token[c.id] } : {}),
          ...(env !== undefined
            ? { environment: JSON.parse(env) as Record<string, string> }
            : {}),
        };
      }
      await client.confirmPluginJob(job.id, {
        requestId: crypto.randomUUID(),
        confirmation: job.confirmation!,
        credentials,
      });
      setJob(null);
      setInspection(null);
      setSelected(null);
      setToken({});
      setEnvironment({});
      setRefresh((v) => v + 1);
    });
  }
  async function change(
    item: PluginView,
    action: "disable" | "uninstall" | "inherit",
  ) {
    if (
      action === "uninstall" &&
      !window.confirm(
        "从所选范围移除此插件？进行中任务保留旧版本，源文件和产物不会删除。",
      )
    )
      return;
    await run(async () => {
      await client.changePlugin(item.pluginId, {
        ...target,
        requestId: crypto.randomUUID(),
        expectedRevision: item.revision,
        action,
      });
      setRefresh((v) => v + 1);
    });
  }
  const shown = job?.manifest ?? inspection?.manifest ?? selected?.manifest;
  return (
    <Modal
      title="插件"
      onClose={onClose}
      wide
      dirty={Boolean(
        path.trim() ||
          inspection ||
          Object.keys(token).length ||
          Object.keys(environment).length,
      )}
    >
      <p className="muted">
        将 Skill、MCP 和 Hook
        组合使用。变更供新任务使用；进行中的任务保留原版本。
      </p>
      <div className="dialog-actions">
        <label>
          作用域
          <select
            aria-label="插件作用域"
            disabled={busy}
            value={scope}
            onChange={(e) => {
              reset();
              setScope(e.target.value as typeof scope);
            }}
          >
            <option value="user">用户级</option>
            <option value="project">项目级</option>
          </select>
        </label>
        {scope === "project" && (
          <label>
            项目
            <select
              aria-label="插件项目"
              disabled={busy}
              value={project}
              onChange={(e) => {
                reset();
                setProject(e.target.value);
              }}
            >
              <option value="">选择项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="button"
          type="button"
          onClick={() => setRefresh((v) => v + 1)}
        >
          刷新
        </button>
      </div>
      <section className="plugin-install">
        <h3>安装插件</h3>
        <div className="dialog-actions">
          <select
            aria-label="插件来源类型"
            value={kind}
            onChange={(e) => {
              reset();
              setKind(e.target.value as typeof kind);
              setPath("");
            }}
          >
            <option value="local">本地目录</option>
            <option value="git">公开 HTTPS Git 仓库</option>
          </select>
          <input
            aria-label="插件来源"
            placeholder={
              kind === "local"
                ? "插件目录完整路径"
                : "https://github.com/组织/仓库.git"
            }
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setJob(null);
            }}
          />
          {kind === "local" && (
            <button
              className="button"
              type="button"
              onClick={() =>
                void run(async () => {
                  const v = await client.pickDirectory();
                  if (v.status === "selected") {
                    setPath(v.path ?? "");
                    setJob(null);
                  } else if (v.status === "unavailable")
                    setError(v.message ?? "原生窗口不可用，请输入路径。");
                })
              }
            >
              选择目录
            </button>
          )}
        </div>
        {kind === "git" && (
          <div className="dialog-actions">
            <input
              aria-label="Git 版本"
              placeholder="分支 / 标签 / 提交，默认 HEAD"
              value={ref}
              onChange={(e) => {
                setRef(e.target.value);
                setJob(null);
              }}
            />
            <input
              aria-label="包子目录"
              placeholder="包子目录（可选）"
              value={subdirectory}
              onChange={(e) => {
                setSubdirectory(e.target.value);
                setJob(null);
              }}
            />
          </div>
        )}
        <label className="hook-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              setJob(null);
            }}
          />
          确认后启用（取消勾选则仅安装）
        </label>
        <button
          type="button"
          className="button primary"
          disabled={busy || !path || (scope === "project" && !project)}
          onClick={() => {
            setSelected(null);
            setDraft({ excluded: [], mcp: {} });
            setInspection(null);
            setToken({});
            setEnvironment({});
            void preview("install", undefined, { excluded: [], mcp: {} });
          }}
        >
          检查并预览安装
        </button>
      </section>
      <label>
        筛选插件
        <input
          aria-label="筛选插件"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
      <div className="plugin-list">
        {items
          .filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
          .map((p) => (
            <article className="plugin-card" key={p.pluginId}>
              <div className="plugin-heading">
                <strong>{p.name}</strong>
                <span>
                  {p.removed && p.status !== "pending_cleanup"
                    ? "已移除 · 阻止继承"
                    : label[p.status]}
                  {p.inherited ? " · 继承用户级" : ""}
                </span>
              </div>
              <p>{p.description}</p>
              <p className="muted">
                {p.declaredVersion ?? "未声明版本"} · {p.version.slice(0, 12)}{" "}
                {p.commit && ` · Git ${p.commit.slice(0, 12)}`} ·{" "}
                {p.source.kind === "local" ? p.source.path : p.source.url}
              </p>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    reset();
                    setSelected(p);
                    setDraft(p.selection);
                    setEnabled(p.enabled);
                  }}
                >
                  详情与配置
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setSelected(p);
                    setDraft(p.selection);
                    setEnabled(true);
                    void run(async () => {
                      setJob(
                        await client.previewPlugin({
                          ...target,
                          requestId: crypto.randomUUID(),
                          pluginId: p.pluginId,
                          expectedRevision: p.revision,
                          action: "configure",
                          enabled: true,
                          selection: p.selection,
                        }),
                      );
                    });
                  }}
                >
                  预览启用
                </button>
                {p.enabled && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => void change(p, "disable")}
                  >
                    禁用
                  </button>
                )}
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setSelected(p);
                    setEnabled(p.enabled);
                    void preview("update", p, p.selection);
                  }}
                >
                  检查更新
                </button>
                {p.previousVersion && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => {
                      setSelected(p);
                      void preview("rollback", p, p.selection);
                    }}
                  >
                    回退上一版
                  </button>
                )}
                {scope === "project" && !p.inherited && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => void change(p, "inherit")}
                  >
                    恢复用户级继承
                  </button>
                )}
                <button
                  type="button"
                  className="button danger"
                  disabled={busy}
                  onClick={() => void change(p, "uninstall")}
                >
                  卸载
                </button>
              </div>
              {p.connections.map((c) => (
                <p key={c.connectionId}>
                  {c.componentId} · {c.state.status} · {c.state.tools.length}{" "}
                  个工具 {c.state.error}
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      void run(async () => {
                        await client.reconnectMcp(
                          c.connectionId,
                          c.workspaceId,
                        );
                        setRefresh((v) => v + 1);
                      })
                    }
                  >
                    重新连接
                  </button>
                  {c.state.authorizationUrl && (
                    <a
                      href={c.state.authorizationUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      登录
                    </a>
                  )}
                </p>
              ))}
              {p.activeRunIds.length > 0 && (
                <p>
                  仍被 {p.activeRunIds.length} 个任务引用
                  {p.activeRunIds.map((id) => (
                    <button
                      type="button"
                      className="button"
                      key={id}
                      onClick={() =>
                        void run(async () => {
                          await client.cancel(id);
                          setRefresh((v) => v + 1);
                        })
                      }
                    >
                      停止任务 {id.slice(0, 8)}
                    </button>
                  ))}
                </p>
              )}
            </article>
          ))}
      </div>
      {job && (
        <p role="status">
          {job.status === "preparing"
            ? "正在获取和校验插件…"
            : job.status === "ready"
              ? job.noChange
                ? "内容与状态无变化"
                : "预览就绪，等待确认"
              : job.status}
          {job.commit && ` · Git ${job.commit.slice(0, 12)}`}{" "}
          {["preparing", "ready"].includes(job.status) && (
            <button
              type="button"
              className="button"
              onClick={() =>
                void run(async () =>
                  setJob(await client.cancelPluginJob(job.id)),
                )
              }
            >
              取消安装任务
            </button>
          )}
        </p>
      )}
      {shown && (
        <section className="hook-preview">
          <h3>{shown.name} · 组件与权限</h3>
          {selected && job?.version && job.version !== selected.version && (
            <div role="status" className="notice">
              <strong>与当前版本的差异</strong>
              <ul>
                {[
                  ...new Set([
                    ...selected.manifest.components.map((c) => c.id),
                    ...shown.components.map((c) => c.id),
                  ]),
                ].map((id) => {
                  const before = selected.manifest.components.find(
                      (c) => c.id === id,
                    ),
                    after = shown.components.find((c) => c.id === id);
                  return !before ? (
                    <li key={id}>新增 {id}</li>
                  ) : !after ? (
                    <li key={id}>移除 {id}</li>
                  ) : JSON.stringify(before) !== JSON.stringify(after) ? (
                    <li key={id}>变更 {id}（请核对下方入口与资源权限）</li>
                  ) : null;
                })}
              </ul>
              <p>包文件或脚本内容也可能变化；确认绑定下方完整包版本。</p>
            </div>
          )}

          {shown.issues.map((i) => (
            <p className="error" key={i.id}>
              {i.message}
            </p>
          ))}
          {shown.components.map((c) => (
            <div key={c.id}>
              <label className="hook-toggle">
                <input
                  type="checkbox"
                  checked={!draft.excluded.includes(c.id)}
                  onChange={(e) => {
                    setDraft((d) => ({
                      ...d,
                      excluded: e.target.checked
                        ? d.excluded.filter((x) => x !== c.id)
                        : [...d.excluded, c.id],
                    }));
                    setJob(null);
                  }}
                />
                {c.kind} · {c.name}
              </label>
              {c.hook && (
                <p>
                  {c.hook.event} · {c.hook.tools?.join("、") ?? "全部工具"} ·{" "}
                  {c.hook.interpreter} {c.hook.packagePath}/{c.hook.entry}
                  <br />
                  项目与包默认只读；写入：
                  {c.hook.permissions.writePaths.join("、") || "无"}；网络：
                  {c.hook.permissions.networkDomains.join("、") || "无"}
                </p>
              )}
              {c.mcp && (
                <>
                  <pre>{JSON.stringify(c.mcp, null, 2)}</pre>
                  <label>
                    工具提供方式
                    <select
                      value={
                        draft.mcp[c.id]?.toolExposure ??
                        c.mcp.toolExposure ??
                        "deferred"
                      }
                      onChange={(e) => {
                        setDraft((d) => ({
                          ...d,
                          mcp: {
                            ...d.mcp,
                            [c.id]: {
                              ...d.mcp[c.id],
                              toolExposure: e.target.value as
                                | "direct"
                                | "deferred",
                            },
                          },
                        }));
                        setJob(null);
                      }}
                    >
                      <option value="deferred">按需加载</option>
                      <option value="direct">直接提供</option>
                    </select>
                  </label>
                  <label>
                    认证
                    <select
                      value={draft.mcp[c.id]?.auth ?? c.mcp.auth ?? "none"}
                      onChange={(e) => {
                        setDraft((d) => ({
                          ...d,
                          mcp: {
                            ...d.mcp,
                            [c.id]: {
                              ...d.mcp[c.id],
                              auth: e.target.value as
                                | "none"
                                | "token"
                                | "oauth",
                            },
                          },
                        }));
                        setJob(null);
                      }}
                    >
                      <option value="none">无</option>
                      <option value="token">Token</option>
                      <option value="oauth">OAuth</option>
                    </select>
                  </label>
                  <label>
                    更换 Token（不填写则保留已有凭证）
                    <input
                      type="password"
                      autoComplete="off"
                      value={token[c.id] ?? ""}
                      onChange={(e) =>
                        setToken((t) => ({ ...t, [c.id]: e.target.value }))
                      }
                    />
                  </label>
                  <button
                    className="button"
                    type="button"
                    onClick={() => setToken((t) => ({ ...t, [c.id]: "" }))}
                  >
                    清除 Token
                  </button>
                  {token[c.id] === "" && <small>确认后清除已有 Token。</small>}
                  <label>
                    环境变量 JSON（仅提交到凭证服务，输入 {} 清除）
                    <textarea
                      value={environment[c.id] ?? ""}
                      placeholder='{"API_KEY":"..."}'
                      onChange={(e) =>
                        setEnvironment((t) => ({
                          ...t,
                          [c.id]: e.target.value,
                        }))
                      }
                    />
                  </label>
                </>
              )}
            </div>
          ))}
          <div className="dialog-actions">
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() =>
                void preview(
                  inspection?.action ?? (selected ? "configure" : "install"),
                )
              }
            >
              重新预览组件选择
            </button>
            {job?.status === "ready" && (
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => void confirm()}
              >
                确认版本与权限并{job.enabled ? "启用" : "安装"}
              </button>
            )}
          </div>
          <p className="muted">
            确认只授权展示的插件能力，不放行模型的任意命令。旧任务继续使用其原版本。
          </p>
        </section>
      )}
      {jobs.length > 0 && (
        <details>
          <summary>安装与更新任务（{jobs.length}）</summary>
          {jobs.map((j) => (
            <div className="plugin-card" key={j.id}>
              <strong>
                {j.manifest?.name ?? "插件准备"} · {jobLabel[j.status]}
              </strong>
              <p>{j.error}</p>
              {["ready", "preparing"].includes(j.status) && (
                <>
                  <button
                    className="button"
                    type="button"
                    onClick={() => {
                      setJob(j);
                      setInspection(j);
                      setDraft(j.selection);
                      setEnabled(j.enabled);
                      setSelected(
                        j.action === "install"
                          ? null
                          : (items.find((p) => p.pluginId === j.pluginId) ??
                              null),
                      );
                      setKind(j.source.kind);
                      setPath(
                        j.source.kind === "local"
                          ? j.source.path
                          : j.source.url,
                      );
                    }}
                  >
                    查看任务
                  </button>
                  <button
                    className="button"
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        await client.cancelPluginJob(j.id);
                        setRefresh((n) => n + 1);
                      })
                    }
                  >
                    取消此任务
                  </button>
                </>
              )}
            </div>
          ))}
        </details>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
