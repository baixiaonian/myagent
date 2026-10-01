/**
 * 命令权限设置：用户/项目规则、表单与 JSON 共用草稿，并展示磁盘变更和静态检查结果。
 * 轮询不能覆盖未保存输入；确认绑定当前展示的准确版本，测试命令不执行真实进程。
 */
import type {
  ChatClient,
  CommandAssessment,
  CommandConfigTarget,
  CommandConfigView,
  CommandRule,
  CommandRuleDocument,
  Workspace,
} from "@myagent/sdk";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../../components/Modal.js";

const decisionLabels = { allow: "允许", prompt: "询问", deny: "拒绝" };
const initial = '{\n  "schemaVersion": 1,\n  "rules": []\n}';
export function CommandSettingsDialog({
  client,
  initialWorkspaceId,
  onClose,
}: {
  client: ChatClient;
  initialWorkspaceId?: string;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"user" | "project">("user");
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? "");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [editor, setEditor] = useState<{
    view: CommandConfigView;
    text: string;
  } | null>(null);
  const [latest, setLatest] = useState<CommandConfigView | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const generation = useRef(0);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [id, setId] = useState("");
  const [pattern, setPattern] = useState('["git", "status"]');
  const [decision, setDecision] = useState<CommandRule["decision"]>("prompt");
  const [description, setDescription] = useState("");
  const [command, setCommand] = useState("pwd");
  const [assessment, setAssessment] = useState<CommandAssessment | null>(null);
  const target: CommandConfigTarget = {
    scope,
    ...(scope === "project" ? { workspaceId } : {}),
  };
  useEffect(() => {
    let disposed = false;
    void client
      .workspaces()
      .then((result) => {
        if (!disposed)
          setWorkspaces(
            result.workspaces.filter((item) => item.kind !== "diagnostic"),
          );
      })
      .catch((error: Error) => {
        if (!disposed) setNotice(error.message);
      });
    return () => {
      disposed = true;
    };
  }, [client]);
  useEffect(() => {
    let disposed = false;
    let loading = false;
    setEditor(null);
    setLatest(null);
    setAssessment(null);
    setNotice("");
    const load = async () => {
      if (loading || working.current || (scope === "project" && !workspaceId))
        return;
      loading = true;
      const version = generation.current;
      try {
        const view = await client.commandConfig({
          scope,
          ...(scope === "project" ? { workspaceId } : {}),
        });
        if (!disposed && version === generation.current) {
          setLatest(view);
          setEditor(
            (previous) => previous ?? { view, text: view.text || initial },
          );
        }
      } catch (error) {
        if (!disposed)
          setNotice(error instanceof Error ? error.message : "读取规则失败。");
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
      generation.current++;
    };
  }, [client, scope, workspaceId]);
  async function action(operation: () => Promise<void>) {
    generation.current++;
    working.current = true;
    setBusy(true);
    setNotice("");
    try {
      await operation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败。");
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function accept(view: CommandConfigView) {
    setLatest(view);
    setEditor({ view, text: view.text || initial });
    setAssessment(null);
  }
  let document: CommandRuleDocument | null = null;
  try {
    const value = JSON.parse(editor?.text ?? initial) as CommandRuleDocument;
    if (
      value.schemaVersion === 1 &&
      Array.isArray(value.rules) &&
      value.rules.every(
        (rule) =>
          rule &&
          typeof rule.id === "string" &&
          Array.isArray(rule.pattern) &&
          rule.pattern.every((arg) => typeof arg === "string") &&
          ["allow", "prompt", "deny"].includes(rule.decision) &&
          (rule.description === undefined ||
            typeof rule.description === "string"),
      )
    )
      document = value;
  } catch {
    /* 保留非法 JSON 草稿供修复，不能转换成空规则保存。 */
  }
  const changed = Boolean(
    editor && latest && editor.view.revision !== latest.revision,
  );
  const dirty = Boolean(
    editor && editor.text !== (editor.view.text || initial),
  );
  const updateRules = (rules: CommandRule[]) => {
    if (editor)
      setEditor({
        ...editor,
        text: JSON.stringify({ schemaVersion: 1, rules }, null, 2),
      });
    setAssessment(null);
  };
  return (
    <Modal
      title="命令权限"
      onClose={onClose}
      wide
      dirty={Boolean(id || (editor && editor.text !== editor.view.text))}
    >
      <p className="settings-help">
        明确的低风险读取自动执行，其余命令询问。规则按“拒绝 → 询问 →
        允许”取最严格结果；允许命令不会扩大文件和网络权限。
      </p>
      <div className="command-targets">
        <label>
          规则作用域
          <select
            value={scope}
            disabled={busy}
            onChange={(event) => setScope(event.target.value as typeof scope)}
          >
            <option value="user">用户级</option>
            <option value="project">项目级</option>
          </select>
        </label>
        <label>
          当前项目
          <select
            value={workspaceId}
            disabled={busy}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            <option value="">选择项目（用于项目规则和规则测试）</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} · {workspace.path}
              </option>
            ))}
          </select>
        </label>
      </div>
      {notice && <p role="alert">{notice}</p>}
      {scope === "project" && !workspaceId && (
        <p>请先选择已有项目。打开此页面不会创建会话。</p>
      )}
      {editor && (
        <>
          <p className="command-path">
            配置文件：<code>{editor.view.path}</code>
          </p>
          {changed && (
            <p role="status">
              文件已被外部修改。
              {dirty
                ? "当前草稿未被覆盖；加载新版本会丢弃草稿。"
                : "请加载新版本后操作。"}
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => latest && accept(latest)}
              >
                加载新版本
              </button>
            </p>
          )}
          {editor.view.error && <p role="alert">{editor.view.error}</p>}
          {editor.view.pending && (
            <section className="approval-card">
              <strong>项目规则待确认，新命令暂不可执行</strong>
              <p>请核对下面的完整规则；模型修改此文件不能代替你的确认。</p>
              <details>
                <summary>此前已确认规则</summary>
                <pre>{JSON.stringify(editor.view.lastValid, null, 2)}</pre>
              </details>
              <button
                className="button primary"
                type="button"
                disabled={busy || changed || dirty || !editor.view.document}
                onClick={() =>
                  void action(async () =>
                    accept(
                      await client.confirmCommandConfig({
                        ...target,
                        expectedRevision: editor.view.revision,
                      }),
                    ),
                  )
                }
              >
                确认当前文件版本
              </button>
            </section>
          )}
          <div className="inline-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setMode("form")}
            >
              规则表单
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setMode("json")}
            >
              JSON 编辑器
            </button>
          </div>
          {mode === "json" ? (
            <label>
              命令规则 JSON
              <textarea
                className="command-json"
                rows={12}
                value={editor.text}
                disabled={busy}
                onChange={(event) => {
                  setEditor({ ...editor, text: event.target.value });
                  setAssessment(null);
                }}
              />
            </label>
          ) : (
            <>
              {!document ? (
                <p role="alert">JSON 结构无效，请使用 JSON 编辑器修复。</p>
              ) : (
                <>
                  {document.rules.length === 0 && (
                    <p>尚无自定义规则，使用保守的默认检查。</p>
                  )}
                  {document.rules.map((rule) => (
                    <section className="command-rule" key={rule.id}>
                      <div>
                        <strong>{rule.id}</strong> ·{" "}
                        {decisionLabels[rule.decision]}
                        <pre>{JSON.stringify(rule.pattern)}</pre>
                        <p>{rule.description}</p>
                      </div>
                      <div className="inline-actions">
                        <button
                          className="button secondary"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setId(rule.id);
                            setPattern(JSON.stringify(rule.pattern));
                            setDecision(rule.decision);
                            setDescription(rule.description ?? "");
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="button secondary"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            updateRules(
                              document?.rules.filter(
                                (item) => item.id !== rule.id,
                              ) ?? [],
                            )
                          }
                        >
                          删除规则 {rule.id}
                        </button>
                      </div>
                    </section>
                  ))}
                  <fieldset disabled={busy}>
                    <legend>添加或替换规则</legend>
                    <label>
                      规则 ID
                      <input
                        value={id}
                        onChange={(event) => setId(event.target.value)}
                        placeholder="git-status"
                      />
                    </label>
                    <label>
                      参数前缀（JSON 数组）
                      <input
                        value={pattern}
                        onChange={(event) => setPattern(event.target.value)}
                      />
                    </label>
                    <label>
                      命令决策
                      <select
                        value={decision}
                        onChange={(event) =>
                          setDecision(event.target.value as typeof decision)
                        }
                      >
                        <option value="prompt">询问</option>
                        <option value="allow">允许</option>
                        <option value="deny">拒绝</option>
                      </select>
                    </label>
                    <label>
                      规则说明
                      <input
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                      />
                    </label>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={!id.trim()}
                      onClick={() => {
                        try {
                          const args: unknown = JSON.parse(pattern);
                          if (
                            !Array.isArray(args) ||
                            !args.length ||
                            !args[0] ||
                            !args.every((arg) => typeof arg === "string")
                          )
                            throw new Error("请输入非空字符串参数数组。");
                          updateRules([
                            ...(document?.rules.filter(
                              (rule) => rule.id !== id.trim(),
                            ) ?? []),
                            {
                              id: id.trim(),
                              pattern: args,
                              decision,
                              ...(description ? { description } : {}),
                            },
                          ]);
                          setNotice("规则已加入草稿，请保存生效。");
                        } catch {
                          setNotice(
                            '参数前缀必须是非空字符串数组，例如 ["git", "status"]。',
                          );
                        }
                      }}
                    >
                      加入规则草稿
                    </button>
                  </fieldset>
                </>
              )}
            </>
          )}
          <p className="settings-help">
            放行解释器或脚本即信任其后续行为。这里只检查启动命令，不拦截程序内部子进程；批准交互程序后，后续输入不再逐次审批。
          </p>
          <button
            className="button primary"
            type="button"
            disabled={busy || changed}
            onClick={() =>
              void action(async () => {
                accept(
                  await client.saveCommandConfig({
                    ...target,
                    expectedRevision: editor.view.revision,
                    text: editor.text,
                  }),
                );
                setNotice("命令规则已保存。");
              })
            }
          >
            保存命令规则
          </button>
        </>
      )}
      <section className="command-preview">
        <h3>规则测试 · 不执行命令</h3>
        <p>
          检查当前项目的已保存规则，草稿不会参与判断；资源权限与沙箱仍会在真实执行时检查。
        </p>
        <label>
          待检查命令
          <textarea
            rows={3}
            value={command}
            onChange={(event) => {
              setCommand(event.target.value);
              setAssessment(null);
            }}
          />
        </label>
        <button
          className="button secondary"
          type="button"
          disabled={busy || !workspaceId || !command.trim()}
          onClick={() =>
            void action(async () =>
              setAssessment(
                await client.evaluateCommand({ workspaceId, command }),
              ),
            )
          }
        >
          检查命令
        </button>
        {assessment && (
          <div className="command-assessment">
            <strong>检查结果：{decisionLabels[assessment.decision]}</strong>
            <p>目录：{assessment.cwd}</p>
            <ul>
              {[...new Set(assessment.reasons)].map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <details>
              <summary>解析结果与命中规则</summary>
              <pre>
                {JSON.stringify(
                  {
                    commands: assessment.analysis.commands,
                    matches: assessment.matches,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        )}
      </section>
    </Modal>
  );
}
