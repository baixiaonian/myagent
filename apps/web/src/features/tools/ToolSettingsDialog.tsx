/**
 * 独立 MCP 设置页：双作用域文件配置、表单编辑和实际连接/工具目录展示。
 * 轮询只更新服务器视图，不覆盖编辑草稿；秘密仅存在于首次录入的内存表单，保存后清空。
 */

import type {
  ChatClient,
  McpConfigDocument,
  McpConfigView,
  McpOverview,
  McpScope,
  McpServerConfig,
  McpServerView,
  Workspace,
} from "@myagent/sdk";
import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal.js";

const statuses = {
  disabled: "未启用",
  pending: "待确认",
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  authorization_required: "需要登录",
  error: "连接失败",
};
export function ToolSettingsDialog({
  client,
  initialWorkspaceId,
  onClose,
}: {
  client: ChatClient;
  initialWorkspaceId?: string;
  onClose: () => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? "");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [overview, setOverview] = useState<McpOverview | null>(null);
  const [filter, setFilter] = useState<"all" | McpScope>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  // 开关先展示用户意图，提交完成后回到服务端状态；不提前显示连接成功。
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{
    view: McpConfigView;
    mode: "json" | "form";
    originalName?: string;
  } | null>(null);
  const [json, setJson] = useState("");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<McpServerConfig>({
    transport: "http",
    url: "",
    auth: "none",
  });
  const [args, setArgs] = useState("[]");
  const [env, setEnv] = useState("{}");
  const [paths, setPaths] = useState("[]");
  const [remove, setRemove] = useState<McpServerView | null>(null);
  useEffect(() => {
    let disposed = false;
    void client
      .workspaces()
      .then((r) => {
        if (!disposed)
          setWorkspaces(
            r.workspaces.filter(
              (w) =>
                w.kind !== "diagnostic" &&
                (w.kind !== "default" || w.id === initialWorkspaceId),
            ),
          );
      })
      .catch((e) => {
        if (!disposed) setNotice(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [client, initialWorkspaceId]);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await client.mcpOverview(workspaceId || undefined);
        if (!disposed) setOverview(next);
      } catch (e) {
        if (!disposed)
          setNotice(e instanceof Error ? e.message : "加载 MCP 失败。");
      } finally {
        pending = false;
      }
    };
    setOverview(null);
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, workspaceId]);
  async function refresh() {
    setOverview(await client.mcpOverview(workspaceId || undefined));
  }
  async function action(operation: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await operation();
      await refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  }
  async function edit(
    scope: McpScope,
    mode: "json" | "form",
    server?: McpServerView,
  ) {
    const view = await client.mcpConfig({
      scope,
      ...(scope === "project" ? { workspaceId } : {}),
    });
    setEditor({ view, mode, ...(server ? { originalName: server.name } : {}) });
    setJson(
      JSON.stringify(
        view.document ?? view.appliedDocument ?? { mcpServers: {} },
        null,
        2,
      ),
    );
    setName(server?.name ?? "");
    const initial = server?.config ?? {
      transport: "http" as const,
      url: "",
      auth: "none" as const,
    };
    setConfig(structuredClone(initial));
    setArgs(JSON.stringify(initial.args ?? []));
    setEnv(JSON.stringify(initial.env ?? {}, null, 2));
    setPaths(JSON.stringify(initial.additionalPaths ?? []));
  }
  async function saveDocument(
    view: McpConfigView,
    document: McpConfigDocument,
  ) {
    await client.saveMcpConfig({
      ...view.target,
      expectedRevision: view.revision,
      document,
      convertSecrets: true,
    });
  }
  function clearEditor() {
    setEditor(null);
    setJson("");
    setConfig({});
    setEnv("{}");
  }
  async function saveEditor() {
    if (!editor) return;
    let document: McpConfigDocument;
    if (editor.mode === "json")
      document = JSON.parse(json) as McpConfigDocument;
    else {
      document = structuredClone(editor.view.document ?? { mcpServers: {} });
      if (editor.originalName && editor.originalName !== name)
        delete document.mcpServers[editor.originalName];
      document.mcpServers[name] = {
        ...config,
        args: JSON.parse(args),
        env: JSON.parse(env),
        additionalPaths: JSON.parse(paths),
      };
    }
    await saveDocument(editor.view, document);
    clearEditor();
    setNotice("配置已保存，正在连接已启用的服务。");
  }
  async function changeServer(server: McpServerView, deletion = false) {
    const view = await client.mcpConfig({
      scope: server.scope,
      ...(server.scope === "project" ? { workspaceId } : {}),
    });
    if (!view.document || view.pending || view.containsSecrets)
      throw new Error("请先确认或修复此配置文件，再修改服务。");
    if (deletion) delete view.document.mcpServers[server.name];
    else {
      const entry = view.document.mcpServers[server.name];
      if (entry) entry.enabled = !server.enabled;
    }
    await saveDocument(view, view.document);
  }
  return (
    <Modal title="MCP 服务" onClose={onClose} wide dirty={Boolean(editor)}>
      <div className="catalog-heading">
        <span>
          {overview?.servers.length ?? 0} 个服务{" "}
          <span className="muted">
            ·{" "}
            {overview?.servers.filter((server) => server.status === "connected")
              .length ?? 0}{" "}
            个已连接
          </span>
        </span>
      </div>
      <p className="muted">
        添加服务，为 Agent 扩展工具。连接成功后可展开查看工具目录。
      </p>
      <label>
        当前项目
        <select
          aria-label="MCP 当前项目"
          disabled={busy || Boolean(editor)}
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
        >
          <option value="">连接检测目录（无会话）</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} · {w.path}
            </option>
          ))}
        </select>
      </label>
      {overview?.diagnostic && (
        <p className="muted">
          当前在独立检测目录中连接服务；实际任务按各自项目连接。
        </p>
      )}
      <div className="mcp-toolbar">
        <fieldset className="mcp-tabs" aria-label="配置范围">
          {(["all", "user", "project"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              className={filter === value ? "selected" : ""}
              onClick={() => setFilter(value)}
            >
              {value === "all"
                ? "全部"
                : value === "user"
                  ? "用户级"
                  : "项目级"}
            </button>
          ))}
        </fieldset>
        <button
          className="button primary"
          type="button"
          disabled={
            busy || Boolean(editor) || (filter === "project" && !workspaceId)
          }
          onClick={() =>
            void action(() =>
              edit(filter === "project" ? "project" : "user", "form"),
            )
          }
        >
          ＋ 添加 MCP
        </button>
      </div>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <input
        className="catalog-search"
        aria-label="搜索 MCP 服务"
        placeholder="搜索服务或工具名称…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {!overview && <p role="status">加载服务与连接状态…</p>}
      {overview?.configs
        .filter((v) => filter === "all" || v.target.scope === filter)
        .map((view) => (
          <details
            className="mcp-config-source"
            key={view.path}
            open={Boolean(view.pending || view.error)}
          >
            <summary>
              <strong>
                {view.target.scope === "user" ? "用户级配置" : "项目级配置"}
              </strong>
            </summary>
            <code>{view.path}</code>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy || Boolean(editor)}
                onClick={() =>
                  void action(() => edit(view.target.scope, "json"))
                }
              >
                编辑配置文件
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(view.path)
                    .catch(() => setNotice("复制失败，请手动复制路径。"))
                }
              >
                复制路径
              </button>
            </div>
            {view.error && (
              <p role="alert" className="notice error">
                {view.error}
              </p>
            )}
            {view.pending && (
              <div className="notice">
                <p>检测到配置变更。确认后才会启动新命令或连接新地址。</p>
                <details>
                  <summary>查看生效前后的配置</summary>
                  <p>此前配置</p>
                  <pre>{JSON.stringify(view.appliedDocument, null, 2)}</pre>
                  <p>待确认配置</p>
                  <pre>{JSON.stringify(view.document, null, 2)}</pre>
                </details>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || Boolean(view.error)}
                  onClick={() =>
                    void action(async () => {
                      await client.confirmMcpConfig({
                        ...view.target,
                        expectedRevision: view.revision,
                        convertSecrets: true,
                      });
                    })
                  }
                >
                  {view.containsSecrets
                    ? "确认变更并转换凭证"
                    : "确认此版本并连接"}
                </button>
              </div>
            )}
          </details>
        ))}
      {editor && (
        <form
          className="mcp-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void action(saveEditor);
          }}
        >
          <h3>
            {editor.mode === "json"
              ? "编辑配置文件"
              : editor.originalName
                ? "编辑 MCP 服务"
                : "手动添加 MCP"}{" "}
            · {editor.view.target.scope === "user" ? "用户级" : "项目级"}
          </h3>
          {editor.mode === "json" ? (
            <label>
              配置 JSON
              <textarea
                className="json-editor"
                aria-label="配置 JSON"
                spellCheck={false}
                value={json}
                onChange={(e) => setJson(e.target.value)}
              />
            </label>
          ) : (
            <>
              <label>
                服务名称
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如 filesystem"
                />
              </label>
              <label>
                传输方式
                <select
                  value={
                    config.transport ?? (config.command ? "stdio" : "http")
                  }
                  onChange={(e) =>
                    setConfig((previous) => {
                      const { token: _, ...rest } = previous;
                      return {
                        ...rest,
                        transport: e.target.value as "stdio" | "http",
                        auth: "none",
                      };
                    })
                  }
                >
                  <option value="http">HTTP</option>
                  <option value="stdio">本地命令 stdio</option>
                </select>
              </label>
              <label>
                工具提供方式
                <select
                  value={config.toolExposure ?? "deferred"}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      toolExposure: e.target.value as "deferred" | "direct",
                    })
                  }
                >
                  <option value="deferred">按需加载（默认）</option>
                  <option value="direct">直接提供</option>
                </select>
              </label>
              <p className="muted">
                {config.toolExposure === "direct"
                  ? "每次模型请求都提供此服务的全部工具定义，无需先搜索；工具较多时会占用更多上下文。"
                  : "模型先搜索所需工具，再加载定义；同一会话后续提问会复用仍有效的工具，刷新或重启后也可恢复。"}
                两种方式均遵守执行权限。
              </p>
              {config.transport === "stdio" ? (
                <>
                  <label>
                    可执行命令
                    <input
                      required
                      value={config.command ?? ""}
                      onChange={(e) =>
                        setConfig({ ...config, command: e.target.value })
                      }
                      placeholder="npx"
                    />
                  </label>
                  <label>
                    参数数组 JSON
                    <textarea
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                      placeholder={'["-y", "your-mcp-server"]'}
                    />
                  </label>
                  <label>
                    环境变量 JSON
                    <textarea
                      value={env}
                      onChange={(e) => setEnv(e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    服务地址
                    <input
                      required
                      value={config.url ?? ""}
                      onChange={(e) =>
                        setConfig({ ...config, url: e.target.value })
                      }
                      placeholder="https://example.com/mcp"
                    />
                  </label>
                  <label>
                    认证方式
                    <select
                      value={config.auth ?? "none"}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          auth: e.target.value as "none" | "token" | "oauth",
                        })
                      }
                    >
                      <option value="none">无认证</option>
                      <option value="token">Bearer Token</option>
                      <option value="oauth">OAuth 登录</option>
                    </select>
                  </label>
                  {config.auth === "token" && (
                    <label>
                      Token
                      <input
                        type="password"
                        autoComplete="off"
                        value={config.token ?? ""}
                        onChange={(e) =>
                          setConfig({ ...config, token: e.target.value })
                        }
                        placeholder="输入新 Token；已有值显示为引用"
                      />
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          const { token: _, ...rest } = config;
                          setConfig({ ...rest, auth: "none" });
                        }}
                      >
                        清除 Token
                      </button>
                    </label>
                  )}
                  {config.auth === "oauth" && (
                    <>
                      <label>
                        客户端 ID（可选）
                        <input
                          value={config.clientId ?? ""}
                          onChange={(e) =>
                            setConfig({ ...config, clientId: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        客户端元数据地址（可选）
                        <input
                          value={config.clientMetadataUrl ?? ""}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              clientMetadataUrl: e.target.value,
                            })
                          }
                        />
                      </label>
                    </>
                  )}
                </>
              )}
              <details>
                <summary>额外访问范围</summary>
                <label>
                  网络域名（每行一个）
                  <textarea
                    value={config.networkDomains?.join("\n") ?? ""}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        networkDomains: e.target.value
                          .split("\n")
                          .map((v) => v.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                <label>
                  额外目录 JSON
                  <textarea
                    value={paths}
                    onChange={(e) => setPaths(e.target.value)}
                  />
                </label>
              </details>
            </>
          )}
          <p className="muted">
            保存时，新填写的 Token
            和环境变量值会转存至本机凭证服务，配置文件仅保留引用。
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={clearEditor}
            >
              取消编辑
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              确认转换并保存连接
            </button>
          </div>
        </form>
      )}
      <div className="mcp-list">
        {overview?.servers
          .filter(
            (s) =>
              (filter === "all" || s.scope === filter) &&
              `${s.name} ${s.tools.map((tool) => tool.name).join(" ")}`
                .toLowerCase()
                .includes(query.toLowerCase()),
          )
          .map((server) => (
            <details
              className="mcp-server"
              key={`${server.scope}:${server.name}`}
            >
              <summary>
                <strong>{server.name}</strong>
                {server.plugin && (
                  <span>插件 {server.plugin.name} · 在插件页管理</span>
                )}
                <span className="mcp-scope">
                  {server.scope === "user" ? "用户级" : "项目级"}
                </span>
                <span className="mcp-tool-count">
                  {server.tools.length} 个工具
                </span>
                <span className={`mcp-state ${server.status}`}>
                  {statuses[server.status]}
                </span>
                <label className="mcp-toggle">
                  <input
                    aria-label={`启用 ${server.name} ${server.scope}`}
                    type="checkbox"
                    checked={toggling[server.id] ?? server.enabled}
                    disabled={
                      busy || server.status === "pending" || !!server.plugin
                    }
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => {
                      setToggling((old) => ({
                        ...old,
                        [server.id]: !server.enabled,
                      }));
                      void action(() => changeServer(server)).finally(() =>
                        setToggling((old) => {
                          const { [server.id]: _, ...rest } = old;
                          return rest;
                        }),
                      );
                    }}
                  />
                  启用
                </label>
              </summary>
              {server.overridden && (
                <p className="muted">已被当前项目的同名配置覆盖。</p>
              )}
              <p className="muted">
                工具提供方式：
                {server.config.toolExposure === "direct"
                  ? "直接提供"
                  : "按需加载（默认）"}
              </p>
              <code className="project-path">
                {server.config.command
                  ? `${server.config.command} ${(server.config.args ?? []).join(" ")}`
                  : server.config.url}
              </code>
              {server.error && (
                <p role="alert" className="notice error">
                  {server.error}
                </p>
              )}
              <div className="modal-actions">
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || Boolean(editor) || !!server.plugin}
                  onClick={() =>
                    void action(() => edit(server.scope, "form", server))
                  }
                >
                  编辑服务
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={
                    busy ||
                    !server.enabled ||
                    server.overridden ||
                    server.status === "pending"
                  }
                  onClick={() =>
                    void action(async () => {
                      if (overview)
                        await client.reconnectMcp(
                          server.id,
                          overview.workspace.id,
                        );
                    })
                  }
                >
                  重新连接
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || !!server.plugin}
                  onClick={() => setRemove(server)}
                >
                  删除服务
                </button>
                {server.authorizationUrl && (
                  <a
                    className="button primary"
                    href={server.authorizationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    登录授权
                  </a>
                )}
              </div>
              <h4>工具（{server.tools.length}）</h4>
              {server.tools.map((tool) => (
                <details className="mcp-tool" key={tool.name}>
                  <summary>
                    <strong>{tool.name}</strong>
                    <span>
                      {server.status === "connected" ? "当前可用" : "已发现"}
                    </span>
                  </summary>
                  <p>{tool.description}</p>
                  <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
                </details>
              ))}
              {!server.tools.length && (
                <p className="muted">
                  {server.status === "connected"
                    ? "服务未提供工具。"
                    : "连接成功后显示工具目录。"}
                </p>
              )}
            </details>
          ))}
      </div>
      {overview &&
        overview.servers.length > 0 &&
        !overview.servers.some(
          (s) =>
            (filter === "all" || s.scope === filter) &&
            `${s.name} ${s.tools.map((tool) => tool.name).join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        ) && <p className="mcp-empty">没有匹配的服务，试试其他名称或范围。</p>}
      {overview && !overview.servers.length && (
        <p className="mcp-empty">
          还没有 MCP 服务。可以手动添加，或编辑配置文件。
        </p>
      )}
      {remove && (
        <div className="notice">
          <p>删除服务“{remove.name}”并关闭其连接？</p>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setRemove(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await changeServer(remove, true);
                  setRemove(null);
                })
              }
            >
              确认删除服务
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
