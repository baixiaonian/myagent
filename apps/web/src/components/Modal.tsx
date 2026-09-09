/**
 * 通用模态容器：用原生 dialog 管理焦点与遮罩，将 Escape / 关闭操作交回调用方。
 * 仅负责交互容器，不保存设置或会话数据。
 */
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    // 用原生模态模式获得焦点限制和 Escape 行为；调用方通过卸载组件完成关闭。
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`modal ${wide ? "wide" : ""}`}
      aria-label={title}
      onCancel={onClose}
      onClose={onClose}
    >
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
      {children}
    </dialog>
  );
}
