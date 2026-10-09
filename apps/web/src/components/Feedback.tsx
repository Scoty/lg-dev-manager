import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Alert } from './Alert';

/* ---------------- Confirm dialogs ---------------- */

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** Red confirm button, and Cancel gets focus first (destructive actions — AGENTS.md rule 6). */
  danger?: boolean;
}

/* ---------------- Toasts ---------------- */

type ToastKind = 'success' | 'danger' | 'info' | 'warning';
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  text?: string;
}

interface FeedbackValue {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  toast: (t: Omit<Toast, 'id'>) => void;
}

const FeedbackContext = createContext<FeedbackValue | null>(null);

/** App-wide confirm dialog and toasts (replaces window.confirm, which can't be styled or themed). */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...o, resolve });
      }),
    [],
  );

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = nextId.current++;
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.kind === 'danger' ? 9000 : 5000);
  }, []);

  const close = (v: boolean) => {
    pending?.resolve(v);
    setPending(null);
  };

  const value = useMemo(() => ({ confirm, toast }), [confirm, toast]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <Modal
        open={!!pending}
        onClose={() => close(false)}
        title={pending?.title ?? ''}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => close(false)} autoFocus={pending?.danger}>
              {pending?.cancelText ?? 'Cancel'}
            </button>
            <button
              type="button"
              className={`btn ${pending?.danger ? 'btn--danger' : 'btn--primary'}`}
              onClick={() => close(true)}
              autoFocus={!pending?.danger}
            >
              {pending?.confirmText ?? 'OK'}
            </button>
          </>
        }
      >
        {pending?.message}
      </Modal>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div className="toast" key={t.id}>
            <Alert
              kind={t.kind}
              title={t.title}
              action={
                <button type="button" className="close" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
                  <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              }
            >
              {t.text}
            </Alert>
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackValue {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback must be used inside <FeedbackProvider>');
  return ctx;
}
