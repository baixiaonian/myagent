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
