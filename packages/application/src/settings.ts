/**
 * 模型设置用例：校验配置、协调数据库与凭证文件、为运行创建独立连接快照。
 * 模型工厂由 Server 注入；连接测试只执行短请求，不保存配置或创建聊天历史。
 */
import {
  AppError,
  CONTEXT_DEFAULTS,
  LIMITS,
  type PublicSettings,
  type SettingsInput,
} from "@myagent/contracts";
import { contextBudget, type ModelPort, runChat } from "@myagent/kernel";
import type {
  ChatStore,
  CredentialStore,
  StoredSettings,
} from "@myagent/state";
export type ModelFactory = (
  settings: StoredSettings,
  apiKey: string,
  observer?: import("@myagent/observability").ModelTransportObserver,
) => ModelPort;
export class SettingsService {
  transportObserver?: import("@myagent/observability").ModelTransportObserver;
  /** 统一限制所有模型请求；保留调用方的连接快照和凭证边界。 */
  wrapModel?: (model: ModelPort, settings: StoredSettings) => ModelPort;
  constructor(
    private readonly store: ChatStore,
    private readonly credentials: CredentialStore,
    private readonly id: () => string,
    private readonly makeModel: ModelFactory,
  ) {}
  // 对外仅返回是否有密钥和固定掩码；credentialRef 也从读取结果中剔除，避免泄露内部引用。
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
  // 先校验版本及字段，再构造候选配置；本阶段无写入副作用，保存和连接测试可以复用。
  private prepared(input: SettingsInput): {
    settings: StoredSettings;
    secret: string | null;
    changedKey: boolean;
  } {
    const old = this.store.settings();
    if (
      input.apiProtocol !== undefined &&
      !["responses", "chat_completions"].includes(input.apiProtocol)
    )
      throw new AppError("invalid_settings", "请选择支持的模型协议。");
    if (old.revision !== input.expectedRevision)
      throw new AppError(
        "revision_conflict",
        "设置已在其他页面更新，请重新打开设置。",
        409,
      );
    const capacity = {
      contextWindowTokens:
        input.contextWindowTokens ??
        old.contextWindowTokens ??
        CONTEXT_DEFAULTS.contextWindowTokens,
      outputReserveTokens:
        input.outputReserveTokens ??
        old.outputReserveTokens ??
        CONTEXT_DEFAULTS.outputReserveTokens,
    };
    contextBudget(capacity);
    let url: URL;
    try {
      url = new URL(input.baseUrl.trim());
    } catch {
      throw new AppError(
        "invalid_settings",
        "请输入完整的 HTTP 或 HTTPS 接口地址。",
      );
    }
    // 拒绝 URL 内嵌凭证、查询参数和片段；认证材料只能通过专门密钥字段进入后端。
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
    // 未传 apiKey 表示保留旧值，clearKey 表示明确删除；不能把空白输入误当作清除授权。
    const secret = input.clearKey
      ? null
      : (input.apiKey?.trim() ??
        (old.credentialRef ? this.credentials.read(old.credentialRef) : null));
    return {
      settings: {
        ...old,
        ...capacity,
        baseUrl: url.toString().replace(/\/$/, ""),
        model: input.model.trim(),
        apiProtocol: input.apiProtocol ?? old.apiProtocol,
        systemPrompt: input.systemPrompt,
      },
      secret,
      changedKey: input.apiKey !== undefined || input.clearKey === true,
    };
  }
  // 文件和 SQLite 无法共享事务：先写新凭证引用，再提交数据库配置，成功后清理旧引用。
  // 数据库失败时删除本次新引用，旧连接仍可用；文件清理异常允许上抛，不能宣称跨存储原子。
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
  // 一次读取配置和密钥，交给注入工厂生成专属 ModelPort；绝不把密钥加入模型消息。
  model(snapshot?: StoredSettings): {
    model: ModelPort;
    settings: StoredSettings;
  } {
    const settings = snapshot ?? this.store.settings();
    const secret = settings.credentialRef
      ? this.credentials.read(settings.credentialRef)
      : null;
    if (snapshot && !secret)
      throw new AppError(
        "resume_credentials_unavailable",
        "旧运行的凭证已更换或清除，无法恢复原连接。请结束旧运行后重新发起任务。",
        409,
      );
    if (!secret || !settings.model || !settings.baseUrl)
      throw new AppError(
        "settings_required",
        "请先在设置中填写模型接口、模型名称和密钥。",
        409,
      );
    const model = this.makeModel(settings, secret, this.transportObserver);
    return { model: this.wrapModel?.(model, settings) ?? model, settings };
  }
  // 验证尚未保存的候选连接，使用 15 秒短请求；不调用 save，也不创建 Session / Run。
  async test(input: SettingsInput): Promise<void> {
    const { settings, secret } = this.prepared(input);
    if (!secret) throw new AppError("settings_required", "请先填写密钥。");
    const inner =
      this.wrapModel?.(
        this.makeModel(settings, secret, this.transportObserver),
        settings,
      ) ?? this.makeModel(settings, secret, this.transportObserver);
    const model: ModelPort = {
      stream: (messages, signal, tools) =>
        inner.stream(messages, signal, tools, { purpose: "connection_test" }),
    };
    await runChat(
      model,
      [{ role: "user", content: "Reply with OK." }],
      new AbortController().signal,
      () => {},
      15000,
    );
  }
}
