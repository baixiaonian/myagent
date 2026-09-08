import {
  AppError,
  LIMITS,
  type PublicSettings,
  type SettingsInput,
} from "@myagent/contracts";
import { type ModelPort, runChat } from "@myagent/kernel";
import type {
  ChatStore,
  CredentialStore,
  StoredSettings,
} from "@myagent/state";
export type ModelFactory = (
  settings: StoredSettings,
  apiKey: string,
) => ModelPort;
export class SettingsService {
  constructor(
    private readonly store: ChatStore,
    private readonly credentials: CredentialStore,
    private readonly id: () => string,
    private readonly makeModel: ModelFactory,
  ) {}
  get(): PublicSettings {
    const settings = this.store.settings();
    const secret = settings.credentialRef
      ? this.credentials.read(settings.credentialRef)
      : null;
    const { credentialRef: _, ...publicSettings } = settings;
    return {
      ...publicSettings,
      hasKey: Boolean(secret),
      keyMask: secret ? "••••••••" : "",
      configured: Boolean(secret && settings.model && settings.baseUrl),
    };
  }
  private prepared(input: SettingsInput): {
    settings: StoredSettings;
    secret: string | null;
    changedKey: boolean;
  } {
    const old = this.store.settings();
    if (old.revision !== input.expectedRevision)
      throw new AppError(
        "revision_conflict",
        "设置已在其他页面更新，请重新打开设置。",
        409,
      );
    let url: URL;
    try {
      url = new URL(input.baseUrl.trim());
    } catch {
      throw new AppError(
        "invalid_settings",
        "请输入完整的 HTTP 或 HTTPS 接口地址。",
      );
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new AppError(
        "invalid_settings",
        "接口地址仅支持 HTTP/HTTPS，且不能包含凭证、查询参数或片段。",
      );
    if (
      !input.model.trim() ||
      input.model.length > 200 ||
      input.systemPrompt.length > LIMITS.systemCharacters
    )
      throw new AppError(
        "invalid_settings",
        "请填写模型名称，系统提示词不能超过 4000 字符。",
      );
    if (input.clearKey && input.apiKey !== undefined)
      throw new AppError("invalid_settings", "更换和清除密钥不能同时进行。");
    if (
      input.apiKey !== undefined &&
      (!input.apiKey.trim() || /[\r\n]/.test(input.apiKey))
    )
      throw new AppError("invalid_settings", "密钥不能为空或包含换行。");
    const secret = input.clearKey
      ? null
      : (input.apiKey?.trim() ??
        (old.credentialRef ? this.credentials.read(old.credentialRef) : null));
    return {
      settings: {
        ...old,
        baseUrl: url.toString().replace(/\/$/, ""),
        model: input.model.trim(),
        systemPrompt: input.systemPrompt,
      },
      secret,
      changedKey: input.apiKey !== undefined || input.clearKey === true,
    };
  }
  save(input: SettingsInput): PublicSettings {
    const { settings, secret, changedKey } = this.prepared(input);
    const oldRef = settings.credentialRef;
    const newRef = changedKey ? (secret ? this.id() : null) : oldRef;
    if (changedKey && newRef && secret) this.credentials.write(newRef, secret);
    try {
      this.store.saveSettings(
        { ...settings, credentialRef: newRef },
        input.expectedRevision,
      );
    } catch (error) {
      if (newRef && newRef !== oldRef) this.credentials.remove(newRef);
      throw error;
    }
    if (changedKey && oldRef) this.credentials.remove(oldRef);
    return this.get();
  }
  model(): { model: ModelPort; settings: StoredSettings } {
    const settings = this.store.settings();
    const secret = settings.credentialRef
      ? this.credentials.read(settings.credentialRef)
      : null;
    if (!secret || !settings.model || !settings.baseUrl)
      throw new AppError(
        "settings_required",
        "请先在设置中填写模型接口、模型名称和密钥。",
        409,
      );
    return { model: this.makeModel(settings, secret), settings };
  }
  async test(input: SettingsInput): Promise<void> {
    const { settings, secret } = this.prepared(input);
    if (!secret) throw new AppError("settings_required", "请先填写密钥。");
    await runChat(
      this.makeModel(settings, secret),
      [{ role: "user", content: "Reply with OK." }],
      new AbortController().signal,
      () => {},
      15000,
    );
  }
}
