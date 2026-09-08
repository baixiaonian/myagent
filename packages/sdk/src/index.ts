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
export function applyEvent(
  snapshot: SessionSnapshot,
  event: ChatEvent,
): SessionSnapshot {
  if (snapshot.session.id !== event.sessionId || event.seq <= snapshot.cursor)
    return snapshot;
  const next = { ...snapshot, cursor: event.seq };
  if (event.type === "session.updated") next.session = event.session;
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
