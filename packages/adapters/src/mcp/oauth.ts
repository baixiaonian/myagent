/**
 * MCP OAuth 凭证提供方：SDK 处理协议，本层保存 PKCE/state、客户端信息和 Token。
 * 所有认证材料进入既有 0600 凭证文件；公开连接和 SQLite 只保存随机引用。
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AppError } from "@myagent/contracts";
import type {
  CredentialStore,
  ExecutionStore,
  StoredMcpConnection,
} from "@myagent/state";

interface OAuthRecord {
  tokens?: OAuthTokens;
  client?: OAuthClientInformationMixed;
  verifier?: string;
  state?: string;
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
  redirectUrl?: string;
}
export class McpOAuthProvider implements OAuthClientProvider {
  authorizationUrl: string | null = null;
  readonly clientMetadataUrl?: string;
  constructor(
    private readonly connection: StoredMcpConnection,
    private readonly credentials: CredentialStore,
    private readonly store: ExecutionStore,
    readonly redirectUrl: string,
  ) {
    if (connection.clientMetadataUrl)
      this.clientMetadataUrl = connection.clientMetadataUrl;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "MyAgent",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  private load(): OAuthRecord {
    const value = this.connection.oauthRef
      ? this.credentials.read(this.connection.oauthRef)
      : null;
    if (!value) return {};
    try {
      return JSON.parse(value) as OAuthRecord;
    } catch {
      throw new AppError("mcp_credentials", "OAuth 凭证记录损坏。");
    }
  }
  private save(record: OAuthRecord): void {
    const current = this.store.get("connections", this.connection.id);
    if (!current || current.revision !== this.connection.revision)
      throw new AppError(
        "mcp_changed",
        "授权期间 MCP 配置已变化，请重新连接。",
        409,
      );
    if (!this.connection.oauthRef) {
      this.connection.oauthRef = randomUUID();
      this.store.put("connections", this.connection);
    }
    this.credentials.write(this.connection.oauthRef, JSON.stringify(record));
  }
  state(): string {
    const state = randomUUID();
    this.save({
      ...this.load(),
      state,
      expiresAt: Date.now() + 600000,
      redirectUrl: this.redirectUrl,
    });
    return state;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.connection.clientId
      ? { client_id: this.connection.clientId }
      : this.load().client;
  }
  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.save({ ...this.load(), client });
  }
  tokens(): OAuthTokens | undefined {
    return this.load().tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    const record = this.load();
    const refresh = tokens.refresh_token ?? record.tokens?.refresh_token;
    record.tokens = {
      ...tokens,
      ...(refresh ? { refresh_token: refresh } : {}),
    };
    delete record.state;
    delete record.expiresAt;
    delete record.verifier;
    this.save(record);
  }
  redirectToAuthorization(url: URL): void {
    const endpoint = new URL(this.connection.url);
    if (url.protocol !== "https:" && url.origin !== endpoint.origin)
      throw new AppError("mcp_auth_url", "OAuth 授权页面必须使用 HTTPS。");
    this.authorizationUrl = url.toString();
  }
  saveCodeVerifier(verifier: string): void {
    this.save({ ...this.load(), verifier });
  }
  codeVerifier(): string {
    const verifier = this.load().verifier;
    if (!verifier)
      throw new AppError("oauth_expired", "OAuth 授权已过期，请重新连接。");
    return verifier;
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    this.save({ ...this.load(), discovery });
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.load().discovery;
  }
  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    const record = this.load();
    if (scope === "all") {
      this.save({});
      return;
    }
    delete record[scope];
    this.save(record);
  }
  /** 回调与连接、一次性 state、有效期及回调地址绑定；先校验再向 SDK 交换授权码。 */
  consumeState(state: string): void {
    if (!this.accepts(state))
      throw new AppError("oauth_state", "OAuth 回调无效或已过期。", 400);
    const record = this.load();
    delete record.state;
    delete record.expiresAt;
    this.save(record);
  }
  accepts(state: string): boolean {
    const record = this.load();
    const expected = record.state ?? "";
    return Boolean(
      expected &&
        record.expiresAt &&
        record.expiresAt > Date.now() &&
        record.redirectUrl === this.redirectUrl &&
        Buffer.byteLength(expected) === Buffer.byteLength(state) &&
        timingSafeEqual(Buffer.from(expected), Buffer.from(state)),
    );
  }
}
