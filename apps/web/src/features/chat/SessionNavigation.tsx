/**
 * 项目树导航：项目下展示历史会话，支持折叠、项目内新建、重命名和删除入口。
 * 数据只来自 App 的 SDK 快照；折叠只影响本地显示，路由选中会话时展开其所属组。
 */
import type { Session, Workspace } from "@myagent/sdk";
import {
  ChevronDown,
  Edit3,
  Folder,
  MessageSquare,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { groupSessions } from "./session-groups.js";

export function SessionNavigation({
  sessions,
  workspaces,
  selected,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  sessions: Session[];
  workspaces: Workspace[];
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: (project: Workspace | null) => void;
  onRename: (session: Session) => void;
  onDelete: (session: Session) => void;
}) {
  const groups = groupSessions(sessions, workspaces);
  const activeKey = groups.find((group) =>
    group.sessions.some((session) => session.id === selected),
  )?.key;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // 只在选择变化时展开；SSE 更新标题或活动时间不能把用户手动收起的项目重新打开。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同组切换会话也需要展开。
  useEffect(() => {
    if (activeKey) setCollapsed((old) => ({ ...old, [activeKey]: false }));
  }, [activeKey, selected]);
  return (
    <nav aria-label="会话列表" className="project-navigation">
      {groups.map((group) => (
        <section
          key={group.key}
          className="project-group"
          aria-label={`项目：${group.name}`}
          data-project-path={group.project?.path ?? ""}
        >
          <div className="project-heading">
            <button
              type="button"
              className="project-toggle"
              title={group.project?.path ?? "每个对话使用独立目录"}
              aria-expanded={!collapsed[group.key]}
              onClick={() =>
                setCollapsed((old) => ({
                  ...old,
                  [group.key]: !old[group.key],
                }))
              }
            >
              <ChevronDown
                size={12}
                className={collapsed[group.key] ? "collapsed" : ""}
              />
              {group.project ? (
                <Folder size={15} />
              ) : (
                <MessageSquare size={15} />
              )}
              <span>{group.name}</span>
              <small>{group.sessions.length}</small>
            </button>
            <button
              type="button"
              className="icon-button project-new"
              aria-label={`在${group.name}中新建对话`}
              title="新建对话"
              onClick={() => onCreate(group.project)}
            >
              <Plus size={14} />
            </button>
          </div>
          {!collapsed[group.key] && (
            <div className="project-sessions">
              {group.sessions.map((session) => (
                <div
                  key={session.id}
                  className={`session-row ${selected === session.id ? "selected" : ""}`}
                >
                  <button
                    type="button"
                    className="session-select"
                    aria-current={selected === session.id ? "page" : undefined}
                    title={session.title}
                    onClick={() => onSelect(session.id)}
                  >
                    <span>{session.title}</span>
                  </button>
                  <div className="session-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`重命名：${session.title}`}
                      onClick={() => onRename(session)}
                    >
                      <Edit3 size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`删除：${session.title}`}
                      onClick={() => onDelete(session)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              {!group.sessions.length && (
                <p className="project-empty">暂无对话</p>
              )}
            </div>
          )}
        </section>
      ))}
      {!groups.length && (
        <p className="sidebar-empty">选择一个项目，或直接开始对话。</p>
      )}
    </nav>
  );
}
