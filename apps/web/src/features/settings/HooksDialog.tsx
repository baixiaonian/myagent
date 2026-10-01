/** Hook 轻量管理页：编辑、预览准确脚本版本及资源，确认后保存；作用域切换不创建会话。 */
import type {
  ChatClient,
  HookConfigView,
  PluginView,
  Workspace,
} from "@myagent/sdk";
import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal.js";
export function HooksDialog({
  client,
  workspaceId,
  onClose,
}: {
  client: ChatClient;
  workspaceId?: string | undefined;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"user" | "project">("user"),
    [project, setProject] = useState(workspaceId ?? ""),
    [projects, setProjects] = useState<Workspace[]>([]);
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [view, setView] = useState<HookConfigView | null>(null),
    [text, setText] = useState(""),
    [preview, setPreview] = useState<HookConfigView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    void client
      .workspaces()
      .then((v) => setProjects(v.workspaces))
      .catch((e) => setError(String(e)));
  }, [client]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh 是用户明确刷新，不用轮询覆盖未保存的 JSON。
  useEffect(() => {
    let active = true;
    setPreview(null);
    setView(null);
    setError("");
    if (scope === "project" && !project) return;
    void client
      .plugins({
        scope,
        ...(scope === "project" ? { workspaceId: project } : {}),
      })
      .then((v) => {
        if (active) setPlugins(v);
      })
      .catch(() => {});
    void client
      .hookConfig({
        scope,
        ...(scope === "project" ? { workspaceId: project } : {}),
      })
      .then((v) => {
        if (active) {
          setView(v);
          setText(v.text || '{\n  "schemaVersion": 1,\n  "hooks": []\n}');
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [client, scope, project, refresh]);
  async function save(confirm: boolean) {
    if (!view) return;
    setBusy(true);
    setError("");
    try {
      const next = await client.saveHookConfig({
        ...view.target,
        text,
        expectedRevision: view.revision,
        ...(confirm && preview ? { expectedVersion: preview.version } : {}),
      });
      if (next.error) {
        setError(next.error);
        setPreview(null);
      } else if (confirm) {
        setView(next);
        setText(next.text);
        setPreview(null);
      } else setPreview(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Hook 保存失败");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Hook"
      onClose={onClose}
      wide
      dirty={Boolean(
        view &&
          text !== (view.text || '{\n  "schemaVersion": 1,\n  "hooks": []\n}'),
      )}
    >
      <p className="muted">
        在任务开始、工具前后和任务结束时运行本地脚本。默认只读项目；确认只授权此
        Hook，不改变模型工具权限。变更从下一任务生效。
      </p>
      {plugins.some((p) => p.manifest.components.some((c) => c.hook)) && (
        <details>
          <summary>插件提供的 Hook（在插件页管理）</summary>
          {plugins.flatMap((p) =>
            p.manifest.components
              .filter((c) => c.hook)
              .map((c) => (
                <p key={`${p.pluginId}:${c.id}`}>
                  {p.name} · {c.name} · {c.hook?.event} ·{" "}
                  {p.enabled && !p.selection.excluded.includes(c.id)
                    ? "已启用"
                    : "未启用"}
                </p>
              )),
          )}
        </details>
      )}
      <div className="dialog-actions">
        <label>
          作用域
          <select
            aria-label="Hook 作用域"
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
            disabled={busy}
          >
            <option value="user">用户级</option>
            <option value="project">项目级</option>
          </select>
        </label>
        {scope === "project" && (
          <label>
            项目
            <select
              aria-label="Hook 项目"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              disabled={busy}
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
          disabled={busy}
          onClick={() => setRefresh((v) => v + 1)}
        >
          刷新文件
        </button>
      </div>
      {view && (
        <>
          <p className="muted hook-path">{view.path}</p>
          <p role="status">
            {view.pending
              ? view.blocking
                ? "配置或脚本已变化，新任务等待确认"
                : "待确认，尚未启用"
              : "配置已生效"}
          </p>
          {view.error && <p role="alert">{view.error}</p>}
          <label>
            Hook 配置 JSON
            <textarea
              aria-label="Hook 配置 JSON"
              className="hook-editor"
              value={text}
              disabled={busy}
              onChange={(e) => {
                setText(e.target.value);
                setPreview(null);
              }}
              spellCheck={false}
            />
          </label>
          {view.document?.hooks.map((h) => (
            <label className="hook-toggle" key={h.id}>
              <input
                type="checkbox"
                checked={(() => {
                  try {
                    return (
                      JSON.parse(text).hooks.find(
                        (v: { id: string }) => v.id === h.id,
                      )?.enabled !== false
                    );
                  } catch {
                    return h.enabled;
                  }
                })()}
                disabled={busy}
                onChange={(e) => {
                  try {
                    const d = JSON.parse(text);
                    d.hooks = d.hooks.map((v: { id: string }) =>
                      v.id === h.id ? { ...v, enabled: e.target.checked } : v,
                    );
                    setText(JSON.stringify(d, null, 2));
                    setPreview(null);
                  } catch {
                    setError("请先修正 JSON 后再切换启用状态。");
                  }
                }}
              />
              {h.id} · {h.event}
            </label>
          ))}
          <div className="dialog-actions">
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void save(false)}
            >
              预览配置与权限
            </button>
          </div>
        </>
      )}
      {preview && (
        <section className="hook-preview">
          <h3>确认本次 Hook 授权</h3>
          {preview.document?.hooks.map((h) => (
            <div key={h.id}>
              <strong>
                {h.id} · {h.event} · {h.enabled ? "启用" : "未启用"}
              </strong>
              <p>
                {h.tools?.join("、") ?? "全部工具"} · {h.timeoutMs} ms
              </p>
              <code>
                {h.interpreter} {h.packagePath}/{h.entry} {h.args.join(" ")}
              </code>
              <p>
                默认：项目与脚本包只读
                <br />
                写入：{h.permissions.writePaths.join("、") || "无"}
                <br />
                网络：{h.permissions.networkDomains.join("、") || "无"}
              </p>
              <small>
                包版本{" "}
                {preview.packages.find((p) => p.id === h.id)?.version ??
                  "未启用，不执行"}
              </small>
            </div>
          ))}
          {!preview.document?.hooks.length && (
            <p>清空 Hook 配置。新任务不再执行此作用域的检查。</p>
          )}
          <button
            className="button primary"
            type="button"
            disabled={busy}
            onClick={() => void save(true)}
          >
            确认授权并保存
          </button>
        </section>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <details>
        <summary>配置示例</summary>
        <pre>
          {JSON.stringify(
            {
              schemaVersion: 1,
              hooks: [
                {
                  id: "prepare",
                  event: "RunStart",
                  enabled: true,
                  packagePath: "/你的脚本包目录",
                  entry: "main.mjs",
                  interpreter: "node",
                  args: [],
                  timeoutMs: 30000,
                  permissions: { writePaths: [], networkDomains: [] },
                },
              ],
            },
            null,
            2,
          )}
        </pre>
      </details>
    </Modal>
  );
}
