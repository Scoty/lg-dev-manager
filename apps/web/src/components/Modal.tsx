import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from '../shell/icons';

/**
 * Adminator modal (modal-head / modal-body / modal-foot) on a native <dialog>, which gives focus trapping,
 * Escape and an inert page behind it for free.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** False while something is running that must not be interrupted (Escape and backdrop do nothing). */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`modal modal--${size}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="modal-card">
          <div className="modal-head">
            <h2 className="modal-title" id={titleId}>{title}</h2>
            {dismissible && (
              <button type="button" className="icon-btn icon-btn--sm" onClick={onClose} aria-label="Close">
                <Icon name="x" strokeWidth={2} />
              </button>
            )}
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
