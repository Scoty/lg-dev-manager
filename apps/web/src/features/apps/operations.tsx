import { useRef, useState } from 'react';
import { APP_ID_HBCHANNEL, AppsErrorCodes, type AppInfo, type OpProgress } from '@lgdm/protocol';
import { newOpId, onOpProgress, uploadToBridge, useRpc } from '../../bridge/useRpc';
import { BridgeError } from '../../bridge/client';
import { Modal } from '../../components/Modal';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { Alert } from '../../components/Alert';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { toTarget, type SavedDevice } from '../../devices/store';
import { useRefreshDeviceData } from './queries';

type Phase = 'send' | 'copy' | 'install';

interface OpState {
  kind: 'install' | 'remove';
  subject: string;
  phase: Phase;
  percent?: number;
  text?: string;
  done?: { appId?: string; via?: 'devmode' | 'hbchannel' };
  error?: unknown;
}

const PHASES: Record<OpState['kind'], { id: Phase; label: string }[]> = {
  install: [
    { id: 'send', label: 'Send the IPK to the bridge' },
    { id: 'copy', label: 'Copy it to the TV' },
    { id: 'install', label: 'Install' },
  ],
  remove: [{ id: 'install', label: 'Uninstall' }],
};

const phaseOf = (stage: Exclude<OpProgress['stage'], 'cleanup'>): Phase => (stage === 'upload' || stage === 'verify' ? 'copy' : 'install');

const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

function installHint(e: unknown) {
  const { code } = describeError(e);
  if (code === AppsErrorCodes.InsufficientSpace) return 'Free some space on the TV (uninstall apps you don’t use) and try again.';
  if (code === AppsErrorCodes.InstallFailed) return 'The TV rejected the package. Check that it is a webOS IPK made for this TV.';
  if (code === AppsErrorCodes.ChecksumMismatch) return 'The connection to the TV may be unstable. Try again.';
  return null;
}

/**
 * Install / uninstall / launch for the active TV, with the progress dialog (ProgressDialogComponent in the original).
 * Render `dialog` once in the page.
 */
export function useAppOperations(device: SavedDevice | null, apps: AppInfo[] | undefined) {
  const { client, call } = useRpc();
  const { confirm, toast } = useFeedback();
  const refresh = useRefreshDeviceData();
  const [op, setOp] = useState<OpState | null>(null);
  const abort = useRef<AbortController | null>(null);
  const running = !!op && !op.done && op.error === undefined;

  const launch = async (app: AppInfo) => {
    if (!device) return;
    try {
      await call('apps.launch', { device: toTarget(device), id: app.id }, 30_000);
      toast({ kind: 'success', title: `Launched ${app.title ?? app.id}`, text: `On ${device.name}.` });
    } catch (e) {
      toast({ kind: 'danger', title: `Couldn’t launch ${app.title ?? app.id}`, text: describeError(e).message });
    }
  };

  const install = async (file: File) => {
    if (!device || !client || running) return;
    if (!/\.ipk$/i.test(file.name)) {
      toast({ kind: 'warning', title: 'Not an IPK file', text: 'Choose a webOS package ending in .ipk.' });
      return;
    }
    const ac = new AbortController();
    abort.current = ac;
    const opId = newOpId();
    setOp({ kind: 'install', subject: file.name, phase: 'send', percent: 0, text: `0 of ${fmtBytes(file.size)}` });
    const off = onOpProgress(client, opId, (p) => {
      // `cleanup` runs after success and failure alike; it must not move the dialog to another step.
      if (p.stage === 'cleanup') return;
      const phase = phaseOf(p.stage);
      setOp((s) => (s && !s.done && s.error === undefined ? { ...s, phase, percent: p.percent, text: p.text } : s));
    });
    try {
      const uploadId = await uploadToBridge(
        client,
        file,
        (sent, total) =>
          setOp((s) => (s ? { ...s, percent: Math.round((sent / total) * 100), text: `${fmtBytes(sent)} of ${fmtBytes(total)}` } : s)),
        ac.signal,
      );
      setOp((s) => (s ? { ...s, phase: 'copy', percent: undefined, text: 'Starting…' } : s));
      const res = await client.call('apps.install', { device: toTarget(device), uploadId, opId }, 20 * 60_000);
      setOp((s) => (s ? { ...s, done: res } : s));
      refresh(device);
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'cancelled') setOp(null);
      else setOp((s) => (s ? { ...s, error: e } : s));
    } finally {
      off();
      abort.current = null;
    }
  };

  const remove = async (app: AppInfo) => {
    if (!device || !client || running) return;
    const title = app.title ?? app.id;
    const ok = await confirm({
      title: `Uninstall ${title}?`,
      message: (
        <>
          <b>{title}</b> <span className="mono">({app.id})</span> will be removed from {device.name}.
        </>
      ),
      confirmText: 'Uninstall',
      danger: true,
    });
    if (!ok) return;
    if (app.id === APP_ID_HBCHANNEL) {
      const sure = await confirm({
        title: 'Remove Homebrew Channel?',
        message: (
          <Alert kind="danger" title="Danger">
            You’re about to remove Homebrew Channel. On a rooted TV you lose root access immediately.
          </Alert>
        ),
        confirmText: 'Yes, uninstall Homebrew Channel',
        danger: true,
      });
      if (!sure) return;
    }
    const opId = newOpId();
    setOp({ kind: 'remove', subject: title, phase: 'install', text: 'Removing…' });
    const off = onOpProgress(client, opId, (p) => setOp((s) => (s && !s.done && s.error === undefined ? { ...s, text: p.text } : s)));
    try {
      await client.call('apps.remove', { device: toTarget(device), id: app.id, opId }, 5 * 60_000);
      setOp(null);
      toast({ kind: 'success', title: `Uninstalled ${title}` });
      refresh(device);
    } catch (e) {
      setOp((s) => (s ? { ...s, error: e } : s));
    } finally {
      off();
    }
  };

  const installedApp = op?.done?.appId ? apps?.find((a) => a.id === op.done!.appId) : undefined;
  const phases = op ? PHASES[op.kind] : [];
  const current = op ? phases.findIndex((p) => p.id === op.phase) : -1;

  const dialog = (
    <Modal
      open={!!op}
      onClose={() => (running ? abort.current?.abort() : setOp(null))}
      dismissible={!running}
      title={op ? `${op.kind === 'install' ? 'Installing' : 'Uninstalling'} ${op.subject}` : ''}
      footer={
        op && (
          <>
            {running && op.phase === 'send' && (
              <button type="button" className="btn btn--ghost" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            )}
            {!running && op.done && installedApp && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setOp(null);
                  launch(installedApp);
                }}
              >
                <Icon name="play" /> Launch
              </button>
            )}
            {!running && (
              <button type="button" className="btn btn--primary" onClick={() => setOp(null)}>
                {op.error !== undefined ? 'Close' : 'Done'}
              </button>
            )}
          </>
        )
      }
    >
      {op && (
        <div className="stack">
          {phases.length > 1 && (
            <ul className="verify-list">
              {phases.map((p, i) => {
                const state = op.done ? 'done' : i < current ? 'done' : i === current ? (op.error !== undefined ? 'failed' : 'running') : 'pending';
                return (
                  <li key={p.id} className={`verify-step is-${state}`}>
                    <span className="verify-icon">
                      {state === 'running' ? <span className="spinner sm" /> : state === 'done' ? <Icon name="check" strokeWidth={2.6} /> : state === 'failed' ? <Icon name="x" strokeWidth={2.6} /> : <span className="verify-dot" />}
                    </span>
                    {p.label}
                  </li>
                );
              })}
            </ul>
          )}
          {running && (
            <div className="op-progress">
              <div className="op-progress-text">
                <span>{op.text ?? 'Working…'}</span>
                {op.percent !== undefined && <span className="mono">{op.percent}%</span>}
              </div>
              <div className="progress">
                <div
                  className={`progress-fill${op.percent === undefined ? ' is-indeterminate' : ''}`}
                  style={op.percent !== undefined ? { width: `${op.percent}%`, animation: 'none' } : undefined}
                />
              </div>
            </div>
          )}
          {op.done && (
            <Alert kind="success" title={installedApp ? `${installedApp.title ?? installedApp.id} ${installedApp.version ? `v${installedApp.version} ` : ''}is installed` : 'Installed'}>
              {op.done.via === 'hbchannel' ? 'Installed by Homebrew Channel on ' : 'Installed on '}
              {device?.name}.
            </Alert>
          )}
          {op.error !== undefined && (
            <ErrorAlert error={op.error} title={op.kind === 'install' ? 'Install failed' : 'Uninstall failed'} hint={op.kind === 'install' ? installHint(op.error) : null} />
          )}
        </div>
      )}
    </Modal>
  );

  return { install, remove, launch, busy: running, dialog };
}
