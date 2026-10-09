import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Icon } from '../../shell/icons';
import { fmtBytes } from './paths';

/** Ask for a file or folder name (CreateDirectoryMessageComponent; also used for rename). */
export function NameDialog({
  open,
  title,
  label,
  initial = '',
  confirmText,
  taken,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  confirmText: string;
  /** Names already in the folder. */
  taken: string[];
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(initial);
    setError(null);
    setTouched(false);
    // Select the name without its extension, like file managers do on rename.
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      const dot = initial.lastIndexOf('.');
      el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    });
  }, [open, initial]);

  const problem = useMemo(() => {
    const n = name.trim();
    if (!n) return 'Enter a name.';
    if (n.includes('/')) return 'Names can’t contain “/”.';
    if (n === '.' || n === '..') return 'That name isn’t allowed.';
    if (n.length > 255) return 'Keep it under 255 characters.';
    if (n !== initial && taken.includes(n)) return 'Something with that name is already here.';
    return null;
  }, [name, taken, initial]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (problem || name.trim() === initial) {
      if (!problem) onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title={title}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn--primary" disabled={busy}>
            {busy ? <span className="spinner sm" /> : null} {confirmText}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className="stack" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-name`}>
            {label}
          </label>
          <input
            ref={input}
            id={`${id}-name`}
            className={`input mono${touched && problem ? ' is-invalid' : ''}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={255}
          />
          {touched && problem && <span className="field-error">{problem}</span>}
        </div>
        {error !== null && <ErrorAlert error={error} />}
      </form>
    </Modal>
  );
}

export type Preview =
  | { kind: 'loading'; name: string; size: number; got: number }
  | { kind: 'text'; name: string; size: number; text: string; truncated: boolean }
  | { kind: 'image'; name: string; size: number; url: string }
  | { kind: 'binary'; name: string; size: number }
  | { kind: 'error'; name: string; size: number; error: unknown };

/** A file's contents in a dialog: text as plain text (never HTML), images from a blob URL. */
export function PreviewDialog({ preview, onDownload, onClose }: { preview: Preview | null; onDownload: () => void; onClose: () => void }) {
  return (
    <Modal
      open={!!preview}
      onClose={onClose}
      size="lg"
      title={preview?.name ?? ''}
      footer={
        preview && (
          <>
            <span className="muted preview-size">{fmtBytes(preview.size)}</span>
            <button type="button" className="btn btn--ghost" onClick={onDownload} disabled={preview.kind === 'loading'}>
              <Icon name="download" /> Download
            </button>
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Close
            </button>
          </>
        )
      }
    >
      {preview?.kind === 'loading' && (
        <div className="op-progress">
          <div className="op-progress-text">
            <span>Reading from the TV…</span>
            <span className="mono">{fmtBytes(preview.got)}</span>
          </div>
          <div className="progress">
            <div className="progress-fill is-indeterminate" />
          </div>
        </div>
      )}
      {preview?.kind === 'text' && (
        <>
          {preview.truncated && <p className="muted">Showing the first {fmtBytes(preview.text.length)}. Download the file to see all of it.</p>}
          <pre className="file-preview-text">{preview.text || '(empty file)'}</pre>
        </>
      )}
      {preview?.kind === 'image' && (
        <div className="file-preview-image">
          <img src={preview.url} alt={preview.name} />
        </div>
      )}
      {preview?.kind === 'binary' && (
        <div className="empty-state">
          <div className="empty-icon"><Icon name="files" /></div>
          <h3>No preview for this file</h3>
          <p>It doesn’t look like text or an image. Download it to open it on this computer.</p>
        </div>
      )}
      {preview?.kind === 'error' && <ErrorAlert error={preview.error} title="Couldn’t read the file" />}
    </Modal>
  );
}

export interface Progress {
  title: string;
  /** "2 of 5" etc. */
  step?: string;
  text: string;
  percent?: number;
  canCancel: boolean;
  error?: unknown;
  errorTitle?: string;
  /** Offer Skip after an error (more items follow). */
  canSkip?: boolean;
  /** After an error in a batch: what to do next (Retry / Skip / Stop, like the original's message dialog). */
  choose?: (c: 'retry' | 'skip' | 'abort') => void;
}

/** Progress of uploads, downloads and deletes (ProgressDialogComponent in the original). */
export function ProgressDialog({ progress, onCancel, onClose }: { progress: Progress | null; onCancel: () => void; onClose: () => void }) {
  const failed = progress?.error !== undefined;
  return (
    <Modal
      open={!!progress}
      onClose={failed ? (progress?.choose ? () => progress.choose!('abort') : onClose) : onCancel}
      dismissible={failed || !!progress?.canCancel}
      title={progress?.title ?? ''}
      footer={
        progress && (failed && progress.choose ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={() => progress.choose!('abort')}>
              {progress.canSkip ? 'Stop' : 'Close'}
            </button>
            {progress.canSkip && (
              <button type="button" className="btn btn--ghost" onClick={() => progress.choose!('skip')}>
                Skip
              </button>
            )}
            <button type="button" className="btn btn--primary" onClick={() => progress.choose!('retry')}>
              Retry
            </button>
          </>
        ) : failed ? (
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        ) : progress.canCancel ? (
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null)
      }
    >
      {progress && !failed && (
        <div className="op-progress">
          {progress.step && <div className="muted">{progress.step}</div>}
          <div className="op-progress-text">
            <span>{progress.text}</span>
            {progress.percent !== undefined && <span className="mono">{progress.percent}%</span>}
          </div>
          <div className="progress">
            <div
              className={`progress-fill${progress.percent === undefined ? ' is-indeterminate' : ''}`}
              style={progress.percent !== undefined ? { width: `${progress.percent}%`, animation: 'none' } : undefined}
            />
          </div>
        </div>
      )}
      {progress && failed && <ErrorAlert error={progress.error} title={progress.errorTitle} />}
    </Modal>
  );
}
