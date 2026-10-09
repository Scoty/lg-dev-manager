import { useRef, useState } from 'react';
import { APP_ID_HBCHANNEL, AppsErrorCodes, LitefinErrorCodes, RepoErrorCodes, type AppInfo, type OpProgress, type RepoPackage } from '@lgdm/protocol';
import { newOpId, onOpProgress, uploadToBridge, useRpc } from '../../bridge/useRpc';
import { BridgeError } from '../../bridge/client';
import { Modal } from '../../components/Modal';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { Alert } from '../../components/Alert';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { toTarget, type SavedDevice } from '../../devices/store';
import { useRefreshDeviceData } from './queries';
import { INCOMPATIBLE_TEXT, type IncompatibleReason } from '../repo/logic';

type Phase = 'send' | 'copy' | 'install';

interface OpState {
  kind: 'install' | 'repo' | 'remove';
  /** For `repo`: "Installing" or "Updating". */
  verb?: string;
  subject: string;
  phase: Phase;
  percent?: number;
  text?: string;
  done?: { appId?: string; via?: 'devmode' | 'hbchannel'; version?: string };
  error?: unknown;
}

const PHASES: Record<OpState['kind'], { id: Phase; label: string }[]> = {
  install: [
    { id: 'send', label: 'Send the IPK to the bridge' },
    { id: 'copy', label: 'Copy it to the TV' },
    { id: 'install', label: 'Install' },
  ],
  repo: [
    { id: 'copy', label: 'Download the IPK' },
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
  if (code === AppsErrorCodes.ChecksumMismatch) return 'The download or the copy to the TV was damaged. Try again; if it keeps failing, the repository entry may be broken.';
  if (code === AppsErrorCodes.Conflict) return 'An app with the same id came from the LG Content Store (or is built in). Uninstall that one on the TV first.';
  if (code === RepoErrorCodes.DownloadFailed || code === RepoErrorCodes.Unreachable || code === LitefinErrorCodes.Unreachable) return 'Check this computer’s internet connection and try again.';
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

  /**
   * Install or update from the Homebrew repository (installPackage in apps.component.ts). Asks first when the app
   * is marked incompatible with this TV.
   */
  const installFromRepo = async (
    pkg: RepoPackage,
    opts: { channel?: 'stable' | 'beta'; update?: boolean; incompatible?: IncompatibleReason[] | null } = {},
  ) => {
    if (!device || !client || running) return false;
    const channel = opts.channel ?? 'stable';
    if (opts.incompatible?.length) {
      const ok = await confirm({
        title: `${pkg.title} may not work on ${device.name}`,
        message: (
          <>
            <p>The repository marks <b>{pkg.title}</b> as not compatible with this TV:</p>
            <ul className="plain-list">
              {opts.incompatible.map((r) => (
                <li key={r}>{INCOMPATIBLE_TEXT[r]}</li>
              ))}
            </ul>
            <p>It may not work properly, or at all.</p>
          </>
        ),
        confirmText: 'Install anyway',
        danger: true,
      });
      if (!ok) return false;
    }
    const verb = opts.update ? 'Updating' : channel === 'beta' ? 'Installing the beta of' : 'Installing';
    const target = toTarget(device);
    return runWebInstall(verb, pkg.title, (opId) => client.call('apps.installFromRepo', { device: target, id: pkg.id, channel, opId }, 20 * 60_000));
  };

  /** Install one build of a Litefin release from GitHub (M8). */
  const installLitefin = async (tag: string, variant: string, subject: string) => {
    if (!device || !client || running) return false;
    const target = toTarget(device);
    return runWebInstall('Installing', subject, (opId) => client.call('litefin.install', { device: target, tag, variant, opId }, 20 * 60_000));
  };

  /** An install the bridge downloads from the web (Homebrew repo, Litefin), with the progress dialog. */
  const runWebInstall = async (
    verb: string,
    subject: string,
    run: (opId: string) => Promise<{ appId: string; version: string; via: 'devmode' | 'hbchannel' }>,
  ) => {
    if (!device || !client) return false;
    const opId = newOpId();
    setOp({ kind: 'repo', verb, subject, phase: 'copy', text: 'Starting…' });
    const off = onOpProgress(client, opId, (p) => {
      if (p.stage === 'cleanup') return;
      const phase = phaseOf(p.stage);
      setOp((s) => (s && !s.done && s.error === undefined ? { ...s, phase, percent: p.percent, text: p.text } : s));
    });
    try {
      const res = await run(opId);
      setOp((s) => (s ? { ...s, done: res } : s));
      refresh(device);
      return true;
    } catch (e) {
      setOp((s) => (s ? { ...s, error: e } : s));
      return false;
    } finally {
      off();
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
      title={op ? `${op.kind === 'remove' ? 'Uninstalling' : op.kind === 'repo' ? op.verb : 'Installing'} ${op.subject}` : ''}
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
            <Alert
              kind="success"
              title={
                installedApp
                  ? `${installedApp.title ?? installedApp.id} ${installedApp.version ? `v${installedApp.version} ` : ''}is installed`
                  : op.done.version
                    ? `${op.subject} v${op.done.version} is installed`
                    : 'Installed'
              }
            >
              {op.done.via === 'hbchannel' ? 'Installed by Homebrew Channel on ' : 'Installed on '}
              {device?.name}.
            </Alert>
          )}
          {op.error !== undefined && (
            <ErrorAlert error={op.error} title={op.kind === 'remove' ? 'Uninstall failed' : 'Install failed'} hint={op.kind === 'remove' ? null : installHint(op.error)} />
          )}
        </div>
      )}
    </Modal>
  );

  return { install, installFromRepo, installLitefin, remove, launch, busy: running, dialog };
}
