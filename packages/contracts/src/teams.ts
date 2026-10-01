/** 轻量团队公开协议：身份由服务端赋予，消息是协作资料而非用户授权；不含连接凭证及私有续接。 */
import type { JsonValue, RunAccepted, RunStatus, Usage } from "./index.js";
export type AgentContextSelection = {
  mode: "brief" | "recent" | "full";
  turns?: number;
};
export interface TeamMember {
  id: string;
  sessionId: string;
  internalSessionId: string;
  branchId: string;
  name: string;
  instructions: string;
  task: string;
  context: AgentContextSelection;
  status: "idle" | "queued" | "working" | "stopping" | "closed";
  runId: string | null;
  error?: { code: string; message: string };
  revision: number;
  createdAt: string;
}
export interface TeamMessage {
  sequence: number;
  cancelled?: boolean;
  id: string;
  sessionId: string;
  branchId: string;
  rootRunId: string;
  from: string;
  to: string;
  kind: "request" | "inform" | "result";
  resultRefs?: string[];
  content: string;
  replyTo: string | null;
  sourceRunId: string;
  includedRunId: string | null;
  includedStep: number | null;
  repliedBy: string | null;
  createdAt: string;
}
export interface TeamView {
  revision: number;
  rootRunId: string | null;
  members: (TeamMember & {
    runStatus: RunStatus | null;
    usage: Usage | null;
  })[];
  usage: Usage | null;
}
export interface TeamPage<T> {
  items: T[];
  cursor: string | null;
}
/** 编排仅经此中立端口驱动已有应用运行器，不依赖应用实现或另建循环。 */
export interface RunCommandPort {
  startMember(
    sessionId: string,
    rootRunId: string,
    requestId: string,
    content: string,
  ): RunAccepted;
  resume(runId: string): Promise<unknown>;
  stop(runId: string): Promise<unknown>;
  executing(runId: string): boolean;
}
export interface TeamStopInput {
  requestId: string;
  expectedRevision: number;
  close?: boolean;
}
export interface AgentHistoryPage {
  records: JsonValue[];
  cursor: string | null;
}
export const TEAM_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "list_agents",
  "wait_agents",
  "read_agent_history",
  "stop_agent",
] as const;
