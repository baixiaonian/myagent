/**
 * Web 会话导航的纯投影：把全部会话归入项目路径，默认目录和遗留记录归入独立对话。
 * 只改变展示；同路径的多个工作区身份不会合并，绝不迁移会话绑定或执行授权。
 */
import type { Session, Workspace } from "@myagent/sdk";

export interface SessionGroup {
  key: string;
  name: string;
  project: Workspace | null;
  sessions: Session[];
}

/** 使用完整工作区目录而非最近项目列表，避免超过列表上限或旧目录身份的会话丢失。 */
export function groupSessions(
  sessions: Session[],
  workspaces: Workspace[],
): SessionGroup[] {
  const byId = new Map(
    workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const groups = new Map<string, SessionGroup>();
  for (const workspace of [...workspaces].sort((a, b) =>
    (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt),
  )) {
    if (workspace.kind === "default" || workspace.kind === "diagnostic")
      continue;
    if (!groups.has(workspace.path))
      groups.set(workspace.path, {
        key: workspace.path,
        name: workspace.name,
        project: workspace,
        sessions: [],
      });
  }
  const independent: SessionGroup = {
    key: "independent",
    name: "独立对话",
    project: null,
    sessions: [],
  };
  for (const session of [...sessions].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )) {
    const workspace = session.workspaceId
      ? byId.get(session.workspaceId)
      : undefined;
    const group =
      workspace &&
      workspace.kind !== "default" &&
      workspace.kind !== "diagnostic"
        ? groups.get(workspace.path)
        : undefined;
    (group ?? independent).sessions.push(session);
  }
  const result = [...groups.values()].sort((a, b) => {
    const activity = (group: SessionGroup) =>
      group.sessions[0]?.updatedAt ??
      group.project?.lastUsedAt ??
      group.project?.createdAt ??
      "";
    return activity(b).localeCompare(activity(a)) || a.key.localeCompare(b.key);
  });
  if (independent.sessions.length) result.push(independent);
  return result;
}
