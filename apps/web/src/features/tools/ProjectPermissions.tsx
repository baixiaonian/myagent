/** 项目授权菜单：保留可撤销的长期授权入口，不再承担创建和绑定工作区流程。 */

import type { ChatClient, PermissionGrant, Workspace } from "@myagent/sdk";
import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal.js";
export function ProjectPermissions({
  client,
  workspace,
  onClose,
}: {
  client: ChatClient;
  workspace: Workspace;
  onClose: () => void;
}) {
  const [grants, setGrants] = useState<PermissionGrant[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    void client
      .grants(workspace.id)
      .then((r) => {
        if (!disposed) setGrants(r.grants);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [client, workspace.id]);
  return (
    <Modal title="项目与授权" onClose={onClose}>
      <h3>{workspace.name}</h3>
      <code className="project-path">{workspace.path}</code>
      <p>
        此对话始终使用这个目录。更换项目请新建对话；删除对话会保留项目文件。
      </p>
      {error && <p role="alert">{error}</p>}
      {grants
        .filter((g) => !g.revokedAt)
        .map((g) => (
          <div className="grant-row" key={g.id}>
            <pre>{JSON.stringify(g.resources, null, 2)}</pre>
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                void client
                  .revokeGrant(g.id)
                  .then(() => client.grants(workspace.id))
                  .then((r) => setGrants(r.grants))
                  .catch((e) => setError(e.message))
              }
            >
              撤销授权
            </button>
          </div>
        ))}
      {!grants.some((g) => !g.revokedAt) && (
        <p className="muted">当前没有额外授权，工作区内按默认策略执行。</p>
      )}
    </Modal>
  );
}
