import type { ReactNode } from 'react';
import { BridgeError } from '../bridge/client';
import { Alert } from './Alert';

/** What we know about any thrown value, in the bridge's { code, message, detail } shape. */
export function describeError(e: unknown): { code: string; message: string; detail?: string } {
  if (e instanceof BridgeError) return { code: e.code, message: e.message, detail: e.detail };
  if (e instanceof Error) return { code: 'error', message: e.message };
  return { code: 'error', message: String(e) };
}

/**
 * Error with an optional "Technical details" expander — the web version of the original's
 * message-trace dialog (see AGENTS.md → Errors). TV-supplied text is rendered as text, never HTML.
 */
export function ErrorAlert({
  error,
  title,
  hint,
  action,
}: {
  error: unknown;
  title?: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  const { code, message, detail } = describeError(error);
  return (
    <Alert kind="danger" title={title} action={action}>
      <div>{message}</div>
      {hint && <div className="alert-hint">{hint}</div>}
      <details className="error-details">
        <summary>Technical details</summary>
        <pre>{[`code: ${code}`, detail].filter(Boolean).join('\n')}</pre>
      </details>
    </Alert>
  );
}
