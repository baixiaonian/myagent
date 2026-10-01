/**
 * 会话导航分组回归：验证旧工作区身份、同名目录和独立会话不会因界面归类而遗漏。
 * 仅验证纯展示投影；权限和会话绑定仍由后端原始 workspaceId 管理。
 */

import { expect, test } from "vitest";
import { groupSessions } from "../../apps/web/src/features/chat/session-groups.js";
import type { Session, Workspace } from "../../packages/sdk/src/index.js";

const project = (
  id: string,
  path: string,
  kind: Workspace["kind"] = "project",
): Workspace => ({
  id,
  path,
  name: path.split("/").at(-1) ?? path,
  identity: id,
  kind: kind ?? "project",
  createdAt: "2026-09-26T00:00:00Z",
});
const session = (id: string, workspaceId?: string): Session => ({
  id,
  title: id,
  workspaceId: workspaceId ?? null,
  revision: 0,
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
});

test("同路径多身份只合并展示，名称相同的不同项目不合并", () => {
  const old = project("old", "/a/repo");
  const next = {
    ...project("new", "/a/repo"),
    createdAt: "2026-09-26T01:00:00Z",
  };
  const other = project("other", "/b/repo");
  const records = [
    session("旧对话", old.id),
    session("新对话", next.id),
    session("另一个项目", other.id),
  ];
  const groups = groupSessions(records, [old, next, other]);
  expect(groups).toHaveLength(2);
  expect(
    groups.find((g) => g.key === "/a/repo")?.sessions.map((s) => s.id),
  ).toEqual(["旧对话", "新对话"]);
  expect(groups.find((g) => g.key === "/a/repo")?.project?.id).toBe("new");
  expect(records.map((s) => s.workspaceId)).toEqual(["old", "new", "other"]);
});

test("默认目录、未绑定和元数据缺失的历史都有入口，不展示诊断项目", () => {
  const groups = groupSessions(
    [session("默认", "default"), session("遗留"), session("缺失", "missing")],
    [
      project("default", "/tmp/default", "default"),
      project("probe", "/tmp/probe", "diagnostic"),
    ],
  );
  expect(groups.map((g) => g.name)).toEqual(["独立对话"]);
  expect(groups[0]?.sessions).toHaveLength(3);
});

test("超过最近项目上限仍保留全部会话，组内按最近活动排序", () => {
  const workspaces = Array.from({ length: 24 }, (_, i) =>
    project(`${i}`, `/projects/${i}`),
  );
  const sessions = workspaces.map((w) => session(w.id, w.id));
  sessions.push({
    ...session("newest", "0"),
    updatedAt: "2026-09-26T02:00:00Z",
  });
  const groups = groupSessions(sessions, workspaces);
  expect(groups).toHaveLength(24);
  expect(groups.flatMap((g) => g.sessions)).toHaveLength(25);
  expect(groups[0]?.key).toBe("/projects/0");
  expect(groups[0]?.sessions[0]?.id).toBe("newest");
});
