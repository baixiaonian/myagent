/**
 * 模型设置表单：维护尚未保存的地址、模型、系统提示和待替换密钥。
 * 仅通过 SDK 保存、测试或清除；保存成功后清空密钥输入，不写浏览器持久存储。
 */
import type { ChatClient, PublicSettings, SettingsInput } from "@myagent/sdk";
import {
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  PlugZap,
  Save,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Modal } from "../../components/Modal.js";
export function SettingsDialog({
  client,
  settings,
  onChange,
  onClose,
}: {
  client: ChatClient;
  settings: PublicSettings;
  onChange: (settings: PublicSettings) => void;
  onClose: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [key, setKey] = useState("");
  const [prompt, setPrompt] = useState(settings.systemPrompt);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  // 未编辑密钥就省略 apiKey 字段，表示继续使用已保存值；不能将掩码作为密钥重新提交。
  const input = (): SettingsInput => ({
    baseUrl,
    model,
    systemPrompt: prompt,
    expectedRevision: settings.revision,
    ...(key ? { apiKey: key } : {}),
  });
  // 测试与保存分离：测试当前表单，不代表配置已落盘；保存只影响下一次生成。
  async function action(kind: "save" | "test" | "clear") {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === "test") {
        await client.testSettings(input());
        setNotice({ ok: true, text: "连接成功，模型已返回文字响应。" });
      } else {
        // 清除密钥只针对当前已保存配置，不顺便提交表单中未保存的地址或提示词。
        const value =
          kind === "clear"
            ? {
                baseUrl: settings.baseUrl,
                model: settings.model,
                systemPrompt: settings.systemPrompt,
                expectedRevision: settings.revision,
                clearKey: true,
              }
            : input();
        const saved = await client.saveSettings(value);
        onChange(saved);
        // 保存后清除输入值；再次打开设置也只能读到 hasKey 和掩码。
        setKey("");
        setNotice({
          ok: true,
          text:
            kind === "clear"
              ? "已清除本机保存的密钥。"
              : "配置已保存，下次生成将使用新设置。",
        });
      }
    } catch (error) {
      setNotice({
        ok: false,
        text: error instanceof Error ? error.message : "操作失败，请重试。",
      });
    } finally {
      setBusy("");
    }
  }
  return (
    <Modal title="模型设置" wide onClose={onClose}>
      <p className="modal-description">
        连接你自己的模型，让每一次对话都从这里开始。
      </p>
      <div className="settings-banner">
        <KeyRound size={18} />
        <div>
          <strong>数据和密钥保存在本机</strong>
          <span>
            密钥只用于后端连接你填写的模型服务。聊天内容会发送给该模型服务。
          </span>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action("save");
        }}
      >
        <fieldset disabled={Boolean(busy)}>
          <label>
            接口基础地址
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              type="url"
              required
              maxLength={2000}
              autoComplete="off"
            />
          </label>
          <p className="field-hint">
            填写 OpenAI 兼容接口的基础地址，不包含 /chat/completions。
          </p>
          <label>
            模型 ID
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="填写服务商提供的模型名称"
              required
              maxLength={200}
              autoComplete="off"
            />
          </label>
          <label>
            API 密钥
            <div className="input-with-action">
              <input
                aria-label="API 密钥"
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder={
                  settings.hasKey
                    ? "已保存 ••••••••，留空保留原密钥"
                    : "填写你的 API 密钥"
                }
                maxLength={4096}
                autoComplete="new-password"
              />
              {settings.hasKey && (
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label="清除已保存的密钥"
                  onClick={() => void action("clear")}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          </label>
          <label>
            系统提示词 <span className="optional">可选</span>
            <textarea
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="例如：请用简洁的中文回答，并在需要时给出示例。"
              maxLength={4000}
            />
          </label>
        </fieldset>
        {notice && (
          <div
            className={`notice ${notice.ok ? "success" : "error"}`}
            role={notice.ok ? "status" : "alert"}
          >
            {notice.ok && <CheckCircle2 size={16} />}
            {notice.text}
          </div>
        )}
        <div className="settings-footer">
          <button
            type="button"
            className="button secondary"
            disabled={
              Boolean(busy) || (!key && !settings.hasKey) || !model || !baseUrl
            }
            onClick={() => void action("test")}
          >
            {busy === "test" ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <PlugZap size={16} />
            )}
            测试连接
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={Boolean(busy)}
          >
            {busy === "save" ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Save size={16} />
            )}
            保存设置
          </button>
        </div>
        <p className="field-hint footer-hint">
          测试连接会向模型发起一次简短请求；修改设置不会影响当前正在生成的回答。
        </p>
      </form>
    </Modal>
  );
}
