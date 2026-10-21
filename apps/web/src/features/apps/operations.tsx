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
import { useRefreshDeviceData, useTvPower } from './queries';
import { useQueryClient } from '@tanstack/react-query';
import { INCOMPATIBLE_TEXT, type IncompatibleReason } from '../repo/logic';
import { repoParam, useRepoSource } from '../repo/source';
import { fmtBytes } from '../../lib/format';

type Phase = 'send' | 'copy' | 'install';

/** Tooltip of a Launch button while the TV is in standby. */
export const TV_OFF_HINT = 'The TV is off (standby). Turn it on to launch apps.';

interface OpState {
  kind: 'install' | 'repo' | 'remove';
  /** For `repo`: "Installing" or "Updating". */
  verb?: string;
  subject: string;
  /** For `repo`: where the IPK came from ("the Homebrew repository", a custom repository's name, Litefin's releases). */
  from?: string;
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
  // In standby the TV installs and updates apps but can't show one: Launch is disabled (the bridge refuses it too).
  const power = useTvPower(device);
  const tvOff = power.data?.state === 'standby';
  const qc = useQueryClient();
  // On a custom repository's page, installs come from that repository (the bridge looks the app up there).
  const source = useRepoSource();

  const launch = async (app: AppInfo) => {
    if (!device) return;
    try {
      await call('apps.launch', { device: toTarget(device), id: app.id }, 30_000);
      toast({ kind: 'success', title: `Launched ${app.title ?? app.id}`, text: `On ${device.name}.` });
    } catch (e) {
      const { code, message } = describeError(e);
      if (code === AppsErrorCodes.TvOff) {
        toast({ kind: 'warning', title: `${device.name} is off`, text: message });
        qc.invalidateQueries({ queryKey: ['power', device.id] });
      } else {
        toast({ kind: 'danger', title: `Couldn’t launch ${app.title ?? app.id}`, text: message });
      }
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
    opts: {
      channel?: 'stable' | 'beta';
      update?: boolean;
      incompatible?: IncompatibleReason[] | null;
      /**
       * An update offered on the Installed page, which only knows the official repository: the TV doesn't record where
       * an app came from, so ask first — it may replace a build from a custom repository or an IPK file.
       */
      confirmOfficial?: boolean;
    } = {},
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
    if (opts.confirmOfficial && opts.update && !source.custom && pkg.id !== APP_ID_HBCHANNEL) {
      const installed = apps?.find((a) => a.id === pkg.id);
      const ok = await confirm({
        title: `Update ${pkg.title} from the Homebrew repository?`,
        message: (
          <>
            <p style={{ marginTop: 0 }}>
              This installs the official build of <b>{pkg.title}</b>
              {pkg.manifest?.version && <> (v{pkg.manifest.version})</>} from the webOS Homebrew repository
              {installed?.version && <> over v{installed.version}</>}.
            </p>
            <p style={{ marginBottom: 0 }}>
              If you installed it from a custom repository or an IPK file, this replaces that build with the official one,
              and its later updates come from the Homebrew repository. The TV doesn’t record where an app came from.
            </p>
          </>
        ),
        confirmText: 'Update',
      });
      if (!ok) return false;
    }
    if (source.custom) {
      // Each install from an unofficial repository is the user's own call, with the warning in front of them — and
      // with what it would replace: an app with the same id from the official repository or already on the TV.
      const host = new URL(source.custom.url).host;
      const official = await qc
        .fetchQuery({ queryKey: ['repo', 'official'], queryFn: () => call('repo.list', {}, 60_000), staleTime: 5 * 60_000 })
        .then((r) => r.packages.find((p) => p.id === pkg.id))
        .catch(() => undefined);
      const installed = apps?.find((a) => a.id === pkg.id);
      const ok = await confirm({
        title: `Install ${pkg.title} from ${source.custom.name}?`,
        message: (
          <>
            <p style={{ marginTop: 0 }}>
              <b>{source.custom.name}</b> (<span className="mono">{host}</span>) is an unofficial repository. Nobody has
              reviewed its apps: they can be broken or contain malware, and they run on your TV.
            </p>
            {(official || installed) && (
              <p>
                ⚠️ It uses the id <span className="mono">{pkg.id}</span>
                {official && (
                  <>
                    {' '}
                    — the same as <b>{official.title}</b> in the official Homebrew repository
                  </>
                )}
                .{' '}
                {installed
                  ? `${installed.title} is installed on ${device.name} now; this replaces it with ${source.custom.name}’s build, wherever the installed one came from.`
                  : `Installing it means updates come from ${source.custom.name}’s build, not the official one.`}
              </p>
            )}
            <p style={{ marginBottom: 0 }}>Install only if you trust whoever publishes it.</p>
          </>
        ),
        confirmText: opts.update ? 'Update' : 'Install',
        danger: true,
      });
      if (!ok) return false;
    }
    const verb = opts.update ? 'Updating' : channel === 'beta' ? 'Installing the beta of' : 'Installing';
    const target = toTarget(device);
    const from = source.custom ? source.custom.name : 'the Homebrew repository';
    return runWebInstall(verb, pkg.title, from, (opId) => client.call('apps.installFromRepo', { device: target, id: pkg.id, channel, opId, ...repoParam(source) }, 20 * 60_000));
  };

  /** Install one build of a Litefin release from GitHub (M8). */
  const installLitefin = async (tag: string, variant: string, subject: string) => {
    if (!device || !client || running) return false;
    const target = toTarget(device);
    return runWebInstall('Installing', subject, 'Litefin’s GitHub releases', (opId) => client.call('litefin.install', { device: target, tag, variant, opId }, 20 * 60_000));
  };

  /** An install the bridge downloads from the web (Homebrew repo, Litefin), with the progress dialog. */
  const runWebInstall = async (
    verb: string,
    subject: string,
    from: string,
    run: (opId: string) => Promise<{ appId: string; version: string; via: 'devmode' | 'hbchannel' }>,
  ) => {
    if (!device || !client) return false;
    const opId = newOpId();
    setOp({ kind: 'repo', verb, subject, from, phase: 'copy', text: 'Starting…' });
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
                disabled={tvOff}
                title={tvOff ? TV_OFF_HINT : undefined}
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
              {/* Where it came from, not how the TV installed it (rooted TVs use Homebrew Channel's installer for every
                  source, which read as if the app came from the Homebrew repository). */}
              Installed on {device?.name}
              {op.from ? ` from ${op.from}` : ''}.
            </Alert>
          )}
          {op.error !== undefined && (
            <ErrorAlert error={op.error} title={op.kind === 'remove' ? 'Uninstall failed' : 'Install failed'} hint={op.kind === 'remove' ? null : installHint(op.error)} />
          )}
        </div>
      )}
    </Modal>
  );

  return { install, installFromRepo, installLitefin, remove, launch, tvOff, busy: running, dialog };
}
