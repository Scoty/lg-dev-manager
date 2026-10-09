import type { ReactNode } from 'react';

type Kind = 'success' | 'danger' | 'warning' | 'info' | 'primary';

const ICON: Record<Kind, string> = {
  success: '<path d="M20 6 9 17l-5-5"/>',
  danger: '<path d="M18 6 6 18M6 6l12 12"/>',
  warning: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  primary: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
};

/** Adminator `.alert` with its icon column. */
export function Alert({ kind, title, children, action }: { kind: Kind; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`alert ${kind}`} role={kind === 'danger' ? 'alert' : 'status'}>
      <div className="ico">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: ICON[kind] }} />
      </div>
      <div className="body">
        {title && <div className="title">{title}</div>}
        {children}
      </div>
      {action ?? <span />}
    </div>
  );
}
