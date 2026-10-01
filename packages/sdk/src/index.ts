/**
 * Web / CLI 使用的公共客户端：封装 HTTP 命令、SSE 订阅与纯事件投影。
 * 服务端负责状态机；SDK 只处理传输错误、游标连续性与重复事件，不自动重试生成命令。
 */
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatEvent,
  CommandAssessment,
  CommandConfigConfirmation,
  CommandConfigSave,
  CommandConfigTarget,
  CommandConfigView,
  CommandEvaluationInput,
  ContextResumeInput,
  ContextView,
  CreateSessionInput,
  DirectoryListing,
  DirectorySelection,
  ExecutionConcern,
  ExecutionOverview,
  HistoryPage,
  HistoryQuery,
  McpConfigConfirmation,
  McpConfigSave,
  McpConfigTarget,
  McpConfigView,
  McpConnection,
  McpConnectionInput,
  McpLiveState,
  McpOverview,
  McpRemoval,
  MemoryEntry,
  MemoryJobView,
  MemoryOverview,
  MemoryPage,
  MemoryQuery,
  MemoryRead,
  MemorySettings,
  MemoryUpdate,
  PermissionGrant,
  PublicSettings,
  RegenerateInput,
  ResultPage,
  Run,
  RunAccepted,
  RunInput,
  Session,
  SessionMemorySettings,
  SessionSnapshot,
  SettingsInput,
  SkillCatalog,
  SkillEntry,
  SkillSource,
  SkillSourceInput,
  ToolInvocation,
  Workspace,
} from "@myagent/contracts";
import { isActiveRun } from "@myagent/contracts";

export type * from "@myagent/contracts";
export { CONTEXT_DEFAULTS } from "@myagent/contracts";
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
    next.activeRun = isActiveRun(event.run.status) ? event.run : null;
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
  documentFiles(workspaceId: string, path = ".", offset = 0) {
    return this.request<import("@myagent/contracts").DocumentDirectory>(
      `/projects/${encodeURIComponent(workspaceId)}/files?${new URLSearchParams({ path, offset: String(offset) })}`,
    );
  }
  document(workspaceId: string, path: string) {
    return this.request<import("@myagent/contracts").ProjectDocument>(
      `/projects/${encodeURIComponent(workspaceId)}/document?${new URLSearchParams({ path })}`,
    );
  }
  saveDocument(
    workspaceId: string,
    input: import("@myagent/contracts").DocumentSave,
  ) {
    return this.request<import("@myagent/contracts").ProjectDocument>(
      `/projects/${encodeURIComponent(workspaceId)}/document`,
      "PUT",
      input,
    );
  }

  /** 观测查询独立于聊天 SSE，原始材料只由调试页面显式读取。 */
  runObservation(
    runId: string,
  ): Promise<import("@myagent/contracts").RunObservationSummary> {
    return this.request(`/observability/runs/${encodeURIComponent(runId)}`);
  }
  observationSettings() {
    return this.request<
      import("@myagent/contracts").ObservationSettings & {
        dropped: number;
        ledgerFailed: boolean;
        exporter: { failedBatches: number; exportedSpans: number } | null;
        exportEnabled: boolean;
        captureBytes: number;
      }
    >("/observability/settings");
  }
  saveObservationSettings(input: {
    requestId: string;
    expectedRevision: number;
    debug: boolean;
    retentionDays: number;
  }) {
    return this.request<import("@myagent/contracts").ObservationSettings>(
      "/observability/settings",
      "PUT",
      input,
    );
  }
  private observationQuery(
    query: import("@myagent/contracts").ObservationQuery,
  ) {
    return new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => [k, String(v)]),
    ).toString();
  }
  traces(query: import("@myagent/contracts").ObservationQuery = {}) {
    return this.request<{
      items: import("@myagent/contracts").TraceRecord[];
      nextOffset: number | null;
    }>(`/observability/traces?${this.observationQuery(query)}`);
  }
  trace(id: string, spanOffset = 0, eventOffset = 0) {
    return this.request<import("@myagent/contracts").TracePage>(
      `/observability/traces/${encodeURIComponent(id)}?spanOffset=${spanOffset}&eventOffset=${eventOffset}`,
    );
  }
  spanEvidence(traceId: string, spanId: string) {
    return this.request<import("@myagent/contracts").SpanEvidence>(
      `/observability/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}/evidence`,
    );
  }
  modelCalls(query: import("@myagent/contracts").ObservationQuery = {}) {
    return this.request<{
      items: import("@myagent/contracts").ModelCallRecord[];
      nextOffset: number | null;
    }>(`/observability/calls?${this.observationQuery(query)}`);
  }
  modelCall(id: string) {
    return this.request<{
      call: import("@myagent/contracts").ModelCallRecord;
      captures: import("@myagent/contracts").CaptureRecord[];
    }>(`/observability/calls/${encodeURIComponent(id)}`);
  }
  observationUsage(query: import("@myagent/contracts").ObservationQuery = {}) {
    return this.request<{
      total: import("@myagent/contracts").UsageSummary;
      groups: ({ key: string } & import("@myagent/contracts").UsageSummary)[];
      startedAt: string;
    }>(`/observability/usage?${this.observationQuery(query)}`);
  }
  modelPrices() {
    return this.request<import("@myagent/contracts").ModelPrice[]>(
      "/observability/prices",
    );
  }
  saveModelPrice(
    price: Pick<
      import("@myagent/contracts").ModelPrice,
      | "connection"
      | "model"
      | "currency"
      | "input"
      | "output"
      | "cacheRead"
      | "cacheWrite"
    >,
    expectedRevision: number,
  ) {
    return this.request<import("@myagent/contracts").ModelPrice>(
      "/observability/prices",
      "PUT",
      { price, expectedRevision, requestId: crypto.randomUUID() },
    );
  }
  capturePage(callId: string, captureId: string, offset = 0) {
    return this.request<import("@myagent/contracts").CapturePage>(
      `/observability/calls/${encodeURIComponent(callId)}/captures/${encodeURIComponent(captureId)}?offset=${offset}`,
    );
  }
  captureDownload(callId: string, captureId: string) {
    return `${this.base}/observability/calls/${encodeURIComponent(callId)}/captures/${encodeURIComponent(captureId)}?download=1`;
  }
  clearCapture(callId: string, captureId: string, expectedRevision: number) {
    return this.request(
      `/observability/calls/${encodeURIComponent(callId)}/captures/${encodeURIComponent(captureId)}`,
      "DELETE",
      { requestId: crypto.randomUUID(), expectedRevision },
    );
  }

  team(id: string) {
    return this.request<import("@myagent/contracts").TeamView>(
      `/sessions/${encodeURIComponent(id)}/team`,
    );
  }
  teamMessages(id: string, cursor = "latest") {
    return this.request<
      import("@myagent/contracts").TeamPage<
        import("@myagent/contracts").TeamMessage
      >
    >(
      `/sessions/${encodeURIComponent(id)}/team/messages?cursor=${encodeURIComponent(cursor)}`,
    );
  }
  agentHistory(id: string, agentId: string, cursor = "0:0") {
    return this.request<import("@myagent/contracts").AgentHistoryPage>(
      `/sessions/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}/history?cursor=${encodeURIComponent(cursor)}`,
    );
  }
  stopAgent(
    id: string,
    agentId: string,
    input: import("@myagent/contracts").TeamStopInput,
  ) {
    return this.request<import("@myagent/contracts").TeamView>(
      `/sessions/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}/stop`,
      "POST",
      input,
    );
  }

  hookConfig(
    target: import("@myagent/contracts").McpConfigTarget,
  ): Promise<import("@myagent/contracts").HookConfigView> {
    return this.request(
      `/hooks/config?${new URLSearchParams({ scope: target.scope, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}) })}`,
    );
  }
  saveHookConfig(
    input: import("@myagent/contracts").HookConfigSave,
  ): Promise<import("@myagent/contracts").HookConfigView> {
    return this.request("/hooks/config", "PUT", input);
  }
  confirmHookConfig(
    target: import("@myagent/contracts").McpConfigTarget,
    revision: string,
    version: string,
  ): Promise<import("@myagent/contracts").HookConfigView> {
    return this.request("/hooks/confirm", "POST", {
      ...target,
      revision,
      version,
    });
  }
  hooks(
    sessionId: string,
  ): Promise<import("@myagent/contracts").HookExecution[]> {
    return this.request(`/sessions/${sessionId}/hooks`);
  }
  constructor(
    private readonly base = "/api/v1",
    private readonly transport: typeof fetch = (...args) => fetch(...args),
  ) {}
  // HTTP 命令不自动重试。网络失败时结果可能已被服务端提交，是否重发由调用方复用 requestId 决定。
  plugins(
    target: McpConfigTarget,
  ): Promise<import("@myagent/contracts").PluginView[]> {
    return this.request(
      `/plugins?${new URLSearchParams({ scope: target.scope, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}) })}`,
    );
  }
  previewPlugin(
    input: import("@myagent/contracts").PluginMutation,
  ): Promise<import("@myagent/contracts").PluginJob> {
    return this.request("/plugins/preview", "POST", input);
  }
  pluginJobs(
    target: McpConfigTarget,
  ): Promise<import("@myagent/contracts").PluginJob[]> {
    return this.request(
      `/plugins/jobs?${new URLSearchParams({ scope: target.scope, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}) })}`,
    );
  }
  pluginJob(id: string): Promise<import("@myagent/contracts").PluginJob> {
    return this.request(`/plugins/jobs/${encodeURIComponent(id)}`);
  }
  cancelPluginJob(id: string): Promise<import("@myagent/contracts").PluginJob> {
    return this.request(
      `/plugins/jobs/${encodeURIComponent(id)}/cancel`,
      "POST",
      { requestId: crypto.randomUUID() },
    );
  }
  confirmPluginJob(
    id: string,
    input: import("@myagent/contracts").PluginConfirm,
  ): Promise<import("@myagent/contracts").PluginView> {
    return this.request(
      `/plugins/jobs/${encodeURIComponent(id)}/confirm`,
      "POST",
      input,
    );
  }
  changePlugin(
    id: string,
    input: import("@myagent/contracts").PluginChange,
  ): Promise<import("@myagent/contracts").PluginView[]> {
    return this.request(
      `/plugins/${encodeURIComponent(id)}/change`,
      "POST",
      input,
    );
  }
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
  skills(workspaceId?: string) {
    return this.request<SkillCatalog>(
      `/skills${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
    );
  }
  skill(id: string, workspaceId?: string) {
    return this.request<{
      entry: SkillEntry;
      body: string;
      resources: { path: string; bytes: number }[];
    }>(
      `/skills/${encodeURIComponent(id)}${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
    );
  }
  setSkillEnabled(id: string, enabled: boolean, workspaceId?: string) {
    return this.request<{ ok: boolean }>(
      `/skills/${encodeURIComponent(id)}`,
      "PATCH",
      { enabled, ...(workspaceId ? { workspaceId } : {}) },
    );
  }
  addSkillSource(input: SkillSourceInput) {
    return this.request<SkillSource>("/skill-sources", "POST", input);
  }
  changeSkillSource(
    id: string,
    input: {
      expectedRevision: number;
      enabled?: boolean;
      scope?: "user" | "project";
      workspaceId?: string;
    },
  ) {
    return this.request<SkillSource>(
      `/skill-sources/${encodeURIComponent(id)}`,
      "PATCH",
      input,
    );
  }
  removeSkillSource(id: string) {
    return this.request<{ ok: boolean }>(
      `/skill-sources/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }
  settings() {
    return this.request<PublicSettings>("/settings");
  }
  memories() {
    return this.request<MemoryOverview>("/memories");
  }
  syncMemories() {
    return this.request<MemoryOverview>("/memories/sync", "POST", {});
  }
  saveMemorySettings(
    input: Omit<MemorySettings, "revision" | "enabledAt"> & {
      expectedRevision: number;
    },
  ) {
    return this.request<MemorySettings>("/memories/settings", "PUT", input);
  }
  searchMemories(input: MemoryQuery = {}) {
    const query = new URLSearchParams(
      Object.entries(input)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    return this.request<MemoryPage>(`/memories/entries?${query}`);
  }
  readMemory(id: string, cursor?: string, sourceId?: string) {
    const query = new URLSearchParams({
      ...(cursor ? { cursor } : {}),
      ...(sourceId ? { sourceId } : {}),
    });
    return this.request<MemoryRead>(
      `/memories/entries/${encodeURIComponent(id)}?${query}`,
    );
  }
  updateMemory(input: MemoryUpdate) {
    return this.request<{ entry: MemoryEntry | null }>(
      "/memories/entries",
      "POST",
      input,
    );
  }
  undoMemory(id: string, expectedRevision: string, requestId: string) {
    return this.request<{ ok: boolean }>("/memories/undo", "POST", {
      id,
      expectedRevision,
      requestId,
    });
  }
  createMemoryJob(sessionId: string, requestId: string) {
    return this.request<MemoryJobView>("/memories/jobs", "POST", {
      sessionId,
      requestId,
    });
  }
  cancelMemoryJob(id: string) {
    return this.request<{ ok: boolean }>(
      `/memories/jobs/${encodeURIComponent(id)}/cancel`,
      "POST",
      {},
    );
  }
  retryMemoryJob(id: string) {
    return this.request<MemoryJobView>(
      `/memories/jobs/${encodeURIComponent(id)}/retry`,
      "POST",
      {},
    );
  }
  sessionMemory(id: string) {
    return this.request<SessionMemorySettings>(
      `/sessions/${encodeURIComponent(id)}/memory`,
    );
  }
  saveSessionMemory(
    id: string,
    input: Omit<SessionMemorySettings, "id" | "revision"> & {
      expectedRevision: number;
    },
  ) {
    return this.request<SessionMemorySettings>(
      `/sessions/${encodeURIComponent(id)}/memory`,
      "PUT",
      input,
    );
  }
  workspaces() {
    return this.request<{ workspaces: Workspace[] }>("/workspaces");
  }
  createWorkspace(path: string, name: string) {
    return this.request<Workspace>("/workspaces", "POST", { path, name });
  }
  bindWorkspace(
    sessionId: string,
    workspaceId: string,
    expectedRevision: number,
  ) {
    return this.request<SessionSnapshot>(
      `/sessions/${encodeURIComponent(sessionId)}/workspace`,
      "PUT",
      { workspaceId, expectedRevision },
    );
  }
  execution(sessionId: string) {
    return this.request<ExecutionOverview>(
      `/sessions/${encodeURIComponent(sessionId)}/execution`,
    );
  }
  decideApproval(id: string, input: ApprovalDecision) {
    return this.request<ApprovalRequest>(
      `/approvals/${encodeURIComponent(id)}/decision`,
      "POST",
      input,
    );
  }
  grants(workspaceId: string) {
    return this.request<{ grants: PermissionGrant[] }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/grants`,
    );
  }
  revokeGrant(id: string) {
    return this.request<void>(`/grants/${encodeURIComponent(id)}`, "DELETE");
  }
  context(sessionId: string) {
    return this.request<ContextView | null>(
      `/sessions/${encodeURIComponent(sessionId)}/context`,
    );
  }
  history(sessionId: string, query: HistoryQuery = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    return this.request<HistoryPage>(
      `/sessions/${encodeURIComponent(sessionId)}/history?${params}`,
    );
  }
  resume(runId: string, input: ContextResumeInput = {}) {
    return this.request<RunAccepted>(
      `/runs/${encodeURIComponent(runId)}/resume`,
      "POST",
      input,
    );
  }
  resolveInvocation(
    id: string,
    kind: NonNullable<ToolInvocation["resolution"]>["kind"],
    note: string,
  ) {
    return this.request<ToolInvocation | ExecutionConcern>(
      `/invocations/${encodeURIComponent(id)}/resolve`,
      "POST",
      { kind, note },
    );
  }
  result(sessionId: string, resultId: string, cursor?: string) {
    return this.request<ResultPage>(
      `/sessions/${encodeURIComponent(sessionId)}/results/${encodeURIComponent(resultId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
  }
  connections() {
    return this.request<{ connections: McpConnection[] }>("/mcp/connections");
  }
  saveConnection(input: McpConnectionInput, id?: string) {
    return this.request<McpConnection>(
      `/mcp/connections${id ? `/${encodeURIComponent(id)}` : ""}`,
      id ? "PUT" : "POST",
      input,
    );
  }
  connectMcp(id: string, workspaceId: string) {
    return this.request<{
      ok: boolean;
      tools: number;
      authorizationUrl?: string;
    }>(`/mcp/connections/${encodeURIComponent(id)}/connect`, "POST", {
      workspaceId,
    });
  }
  deleteConnection(id: string) {
    return this.request<McpRemoval>(
      `/mcp/connections/${encodeURIComponent(id)}`,
      "DELETE",
    );
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
  projects() {
    return this.request<{ projects: Workspace[] }>("/projects");
  }
  prepareProject(path: string) {
    return this.request<Workspace>("/projects/prepare", "POST", { path });
  }
  pickDirectory() {
    return this.request<DirectorySelection>("/projects/pick", "POST", {});
  }
  directories(path?: string) {
    return this.request<DirectoryListing>(
      `/projects/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    );
  }
  mcpOverview(workspaceId?: string) {
    return this.request<McpOverview>(
      `/mcp/overview${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
    );
  }
  commandConfig(target: CommandConfigTarget) {
    const query = new URLSearchParams({
      scope: target.scope,
      ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
    });
    return this.request<CommandConfigView>(`/command-policy/config?${query}`);
  }
  saveCommandConfig(input: CommandConfigSave) {
    return this.request<CommandConfigView>(
      "/command-policy/config",
      "PUT",
      input,
    );
  }
  confirmCommandConfig(input: CommandConfigConfirmation) {
    return this.request<CommandConfigView>(
      "/command-policy/config/confirm",
      "POST",
      input,
    );
  }
  evaluateCommand(input: CommandEvaluationInput) {
    return this.request<CommandAssessment>(
      "/command-policy/evaluate",
      "POST",
      input,
    );
  }
  mcpConfig(target: McpConfigTarget) {
    return this.request<McpConfigView>(
      `/mcp/config?scope=${target.scope}${target.workspaceId ? `&workspaceId=${encodeURIComponent(target.workspaceId)}` : ""}`,
    );
  }
  saveMcpConfig(input: McpConfigSave) {
    return this.request<McpConfigView>("/mcp/config", "PUT", input);
  }
  confirmMcpConfig(input: McpConfigConfirmation) {
    return this.request<McpConfigView>("/mcp/config/confirm", "POST", input);
  }
  reconnectMcp(id: string, workspaceId: string) {
    return this.request<McpLiveState>(
      `/mcp/servers/${encodeURIComponent(id)}/reconnect`,
      "POST",
      { workspaceId },
    );
  }
  createSession(input: CreateSessionInput = {}) {
    return this.request<Session>("/sessions", "POST", input);
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
