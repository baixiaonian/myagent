/**
 * 通用模态容器：用原生 dialog 管理焦点与遮罩，将 Escape / 关闭操作交回调用方。
 * 仅负责交互容器，不保存设置或会话数据。
 */
import { X } from "lucide-react";
import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { SettingsNavigation, settingsPages } from "./SettingsNavigation.js";
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  dirty = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  dirty?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const navigate = useContext(SettingsNavigation);
  const page = navigate && settingsPages.find((item) => item.title === title);
  const [destination, setDestination] = useState<string | null>(null);
  useEffect(() => {
    // 用原生模态模式获得焦点限制和 Escape 行为；调用方通过卸载组件完成关闭。
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`modal ${wide ? "wide" : ""} ${page ? "settings-workspace" : ""}`}
      aria-label={title}
      onCancel={onClose}
      onClose={onClose}
    >
      {page && (
        <nav className="settings-navigation" aria-label="设置分类">
          <strong>设置</strong>
          {settingsPages.map((item) => (
            <button
              type="button"
              key={item.title}
              aria-current={title === item.title ? "page" : undefined}
              onClick={() => {
                if (title === item.title) return;
                if (dirty) setDestination(item.title);
                else navigate?.(item.title);
              }}
            >
              <item.icon size={17} />
              {item.title}
            </button>
          ))}
        </nav>
      )}
      <div className={page ? "settings-content" : "modal-content"}>
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {page && <p className="settings-description">{page.description}</p>}
        {destination && (
          <div className="notice" role="alert">
            <p>有尚未保存的输入。切换设置页会放弃这些输入。</p>
            <div className="inline-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDestination(null)}
              >
                留在当前页
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => navigate?.(destination)}
              >
                放弃并切换
              </button>
            </div>
          </div>
        )}
        {children}
      </div>
    </dialog>
  );
}
