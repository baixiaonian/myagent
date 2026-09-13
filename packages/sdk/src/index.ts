/**
 * Web / CLI 使用的公共客户端：封装 HTTP 命令、SSE 订阅与纯事件投影。
 * 服务端负责状态机；SDK 只处理传输错误、游标连续性与重复事件，不自动重试生成命令。
 */
import type {
  ChatEvent,
  PublicSettings,
  RegenerateInput,
  Run,
  RunAccepted,
  RunInput,
  Session,
  SessionSnapshot,
  SettingsInput,
} from "@myagent/contracts";

export type * from "@myagent/contracts";
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
// 纯投影函数：只产生下一个快照，不调用网络或存储；拒绝其他会话和已应用过的事件。
export function applyEvent(
  snapshot: SessionSnapshot,
  event: ChatEvent,
): SessionSnapshot {
  if (snapshot.session.id !== event.sessionId || event.seq <= snapshot.cursor)
    return snapshot;
  const next = { ...snapshot, cursor: event.seq };
  if (event.type === "step.updated") {
    const steps = next.steps ?? [];
    next.steps = steps.some((s) => s.id === event.step.id)
      ? steps.map((s) => (s.id === event.step.id ? event.step : s))
      : [...steps, event.step];
  }
  if (event.type === "step.delta")
    next.steps = (next.steps ?? []).map((s) =>
      s.id === event.stepId ? { ...s, content: s.content + event.delta } : s,
    );
  if (event.type === "session.updated") next.session = event.session;
  // 最新运行用于显示失败 / 停止状态；activeRun 只保留 running，终态事件会解除输入区忙碌状态。
  if (event.type === "run.updated") {
    next.latestRun = event.run;
    next.activeRun = event.run.status === "running" ? event.run : null;
  }
  if (event.type === "message.delta")
    next.messages = next.messages.map((message) =>
      message.id === event.messageId
        ? { ...message, content: message.content + event.delta }
        : message,
    );
  if (event.type === "message.created" || event.type === "message.updated")
    next.messages = next.messages.some(
      (message) => message.id === event.message.id,
    )
      ? next.messages.map((message) =>
          message.id === event.message.id ? event.message : message,
        )
      : [...next.messages, event.message];
  return next;
}
export class ChatClient {
  constructor(
    private readonly base = "/api/v1",
    private readonly transport: typeof fetch = (...args) => fetch(...args),
  ) {}
  // HTTP 命令不自动重试。网络失败时结果可能已被服务端提交，是否重发由调用方复用 requestId 决定。
  private async request<T>(
    path: string,
    method = "GET",
    data?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.transport(`${this.base}${path}`, {
        method,
        headers:
          data !== undefined ? { "Content-Type": "application/json" } : {},
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      });
    } catch {
      throw new ApiError(
        "network",
        "无法连接本地服务，请检查服务是否正在运行。",
        0,
      );
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { code: string; message: string };
      } | null;
      throw new ApiError(
        payload?.error?.code ?? "http_error",
        payload?.error?.message ?? "请求失败，请稍后重试。",
        response.status,
      );
    }
    // 删除接口没有 JSON 响应体，必须先处理 204，避免把成功删除误报为解析失败。
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  settings() {
    return this.request<PublicSettings>("/settings");
  }
  saveSettings(input: SettingsInput) {
    return this.request<PublicSettings>("/settings", "PUT", input);
  }
  testSettings(input: SettingsInput) {
    return this.request<{ ok: true }>("/settings/test", "POST", input);
  }
  listSessions() {
    return this.request<{ sessions: Session[] }>("/sessions");
  }
  createSession() {
    return this.request<Session>("/sessions", "POST", {});
  }
  session(id: string) {
    return this.request<SessionSnapshot>(`/sessions/${encodeURIComponent(id)}`);
  }
  rename(id: string, title: string, expectedRevision: number) {
    return this.request<Session>(
      `/sessions/${encodeURIComponent(id)}`,
      "PATCH",
      { title, expectedRevision },
    );
  }
  delete(id: string) {
    return this.request<void>(`/sessions/${encodeURIComponent(id)}`, "DELETE");
  }
  send(id: string, input: RunInput) {
    return this.request<RunAccepted>(
      `/sessions/${encodeURIComponent(id)}/runs`,
      "POST",
      input,
    );
  }
  regenerate(id: string, input: RegenerateInput) {
    return this.request<RunAccepted>(
      `/sessions/${encodeURIComponent(id)}/regenerate`,
      "POST",
      input,
    );
  }
  cancel(id: string) {
    return this.request<Run>(
      `/runs/${encodeURIComponent(id)}/cancel`,
      "POST",
      {},
    );
  }
  // EventSource 负责断线重连并发送 Last-Event-ID；初次订阅使用快照 cursor 作为 after。
  // 返回函数仅关闭订阅，禁止顺带请求取消 Run。
  subscribe(
    id: string,
    after: number,
    onEvent: (event: ChatEvent) => void,
    onState: (state: "connected" | "reconnecting") => void,
    onReset: (deleted: boolean) => void,
  ): () => void {
    const source = new EventSource(
      `${this.base}/sessions/${encodeURIComponent(id)}/events?after=${after}`,
    );
    let cursor = after;
    source.onopen = () => onState("connected");
    source.onerror = () => onState("reconnecting");
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ChatEvent;
        if (event.seq <= cursor) return;
        // 丢失中间事件后不能继续拼接答案；关闭流并要求调用方重新读快照，避免显示残缺内容。
        if (event.seq !== cursor + 1) {
          source.close();
          onReset(false);
          return;
        }
        cursor = event.seq;
        onEvent(event);
      } catch {
        source.close();
        onReset(false);
      }
    };
    // 服务端确认会话已删除时停止重连；普通不可用则让页面重载快照以恢复展示。
    source.addEventListener("deleted", () => {
      source.close();
      onReset(true);
    });
    source.addEventListener("unavailable", () => {
      source.close();
      onReset(false);
    });
    return () => source.close();
  }
}
