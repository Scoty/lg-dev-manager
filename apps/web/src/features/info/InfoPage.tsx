import { webosName } from '../../lib/webosVersion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { APP_ID_HBCHANNEL } from '@lgdm/protocol';
import { PageHeader } from '../../components/PageHeader';
import { NeedsDevice } from '../../components/NeedsDevice';
import { Card } from '../../components/Card';
import { Alert } from '../../components/Alert';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { Modal } from '../../components/Modal';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useRpc } from '../../bridge/useRpc';
import { useDevices } from '../../devices/useDevices';
import { setDeviceInfo, toTarget, tvInfo, type SavedDevice } from '../../devices/store';
import { modelLabel, modelSeries } from '../../devices/model';
import { useAppOperations } from '../apps/operations';
import { useInstalledApps } from '../apps/queries';
import { hasUpdate } from '../repo/logic';
import { useHbChannel, useRepoIndex } from '../repo/queries';
import { saveBlob } from '../files/transfer';
import { ScreenshotCard } from './ScreenshotCard';
import { fmtCountdown, parseRemaining, renewScript, resetUrl } from './renewScript';

/** Device info (InfoComponent in the original): the TV, its Developer Mode session, screenshots and Homebrew Channel. */
export function InfoPage() {
  const { active } = useDevices();
  return (
    <>
      <PageHeader eyebrow="Device" title="Device" accent="info" sub={active ? <>Details of <b>{active.name}</b>.</> : 'Details of your TV.'} />
      <div className="grid">
        <NeedsDevice device={active}>{active && <InfoCards key={`${active.id}:${active.updatedAt}`} device={active} />}</NeedsDevice>
      </div>
    </>
  );
}

function InfoCards({ device }: { device: SavedDevice }) {
  const devMode = device.username === 'prisoner';
  return (
    <>
      <DeviceCard device={device} />
      {devMode ? <DevModeCard device={device} /> : <HomebrewCard device={device} />}
      <ScreenshotCard device={device} className={devMode ? 'col-8' : 'col-12'} />
      {devMode && <HomebrewCard device={device} />}
    </>
  );
}

function DeviceCard({ device }: { device: SavedDevice }) {
  const { ready, call } = useRpc();
  const target = useMemo(() => toTarget(device), [device]);
  const info = useQuery({
    queryKey: ['device-info', device.id, device.updatedAt],
    queryFn: async () => {
      const r = await call('device.info', { device: target }, 40_000);
      setDeviceInfo(device.id, tvInfo(device, r)).catch(() => {});
      return r;
    },
    enabled: ready,
    staleTime: 60_000,
    retry: false,
  });
  const d = info.data;
  const series = modelSeries(d?.modelName);
  return (
    <Card
      eyebrow="Device"
      title={d?.modelName ? (modelLabel(d.modelName) ?? d.modelName) : device.name}
      className="col-8"
      action={
        <button type="button" className="btn btn--icon btn--ghost" onClick={() => info.refetch()} disabled={info.isFetching} aria-label="Refresh" title="Refresh">
          <Icon name="refresh" className={info.isFetching ? 'spin' : undefined} />
        </button>
      }
    >
      {info.error ? (
        <ErrorAlert error={info.error} title="Couldn’t read the TV’s details" action={<button type="button" className="btn btn--sm btn--ghost" onClick={() => info.refetch()}>Retry</button>} />
      ) : !d ? (
        <div className="empty-state"><span className="spinner" /><p>Asking {device.name}…</p></div>
      ) : (
        <div className="info-device">
          <div className="info-device-art" aria-hidden="true">
            <Icon name="tv" />
            {series && <span>{series}</span>}
          </div>
          <dl className="kv info-kv">
            <dt>Model</dt>
            <dd className="mono">{d.modelName ?? '—'}</dd>
            <dt>webOS</dt>
            <dd>{webosName(d.osVersion) ?? '—'}</dd>
            <dt>Firmware</dt>
            <dd className="mono">{d.firmwareVersion ?? '—'}</dd>
            <dt>OTA ID</dt>
            <dd className="mono">{d.otaId ?? '—'}</dd>
            <dt>SoC</dt>
            <dd className="mono">{d.socName ?? '—'}</dd>
            <dt>Address</dt>
            <dd className="mono">{device.host}:{device.port}</dd>
            <dt>Logged in as</dt>
            <dd>
              <span className="mono">{device.username}</span>{' '}
              <span className={`badge ${device.mode === 'rooted' ? 'purple' : 'info'}`}>{device.mode === 'rooted' ? 'Rooted' : 'Dev Mode'}</span>
            </dd>
          </dl>
        </div>
      )}
    </Card>
  );
}

/** Ticks a countdown from the time LG reported (DevmodeCountdownPipe). */
function useCountdown(remaining: string | undefined, at: number) {
  const total = parseRemaining(remaining);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (total === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [total]);
  if (total === null) return null;
  const left = Math.min(total, Math.max(0, total - (now - at)));
  return { left, ends: new Date(at + total) };
}

const SESSION_MS = 1000 * 3600 * 1000;

function DevModeCard({ device }: { device: SavedDevice }) {
  const { ready, call } = useRpc();
  const { toast } = useFeedback();
  const target = useMemo(() => toTarget(device), [device]);
  const [renewing, setRenewing] = useState(false);
  const [showAuto, setShowAuto] = useState(false);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(refetchTimer.current), []);
  const status = useQuery({
    queryKey: ['devmode', device.id, device.updatedAt],
    queryFn: async () => ({ ...(await call('devmode.status', { device: target }, 40_000)), at: Date.now() }),
    enabled: ready,
    staleTime: 60_000,
    retry: false,
  });
  const countdown = useCountdown(status.data?.remaining, status.data?.at ?? Date.now());

  const renew = async () => {
    setRenewing(true);
    try {
      await call('devmode.renew', { device: target }, 40_000);
      toast({ kind: 'success', title: 'Developer Mode session renewed', text: 'LG may take a moment to show the new time.' });
      // The Developer Mode app renews in the background; ask again shortly after.
      clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => status.refetch(), 1500);
    } catch (e) {
      toast({ kind: 'danger', title: 'Couldn’t renew the session', text: describeError(e).message });
    } finally {
      setRenewing(false);
    }
  };

  const pct = countdown ? Math.min(100, Math.round((countdown.left / SESSION_MS) * 100)) : 0;
  const low = countdown ? countdown.left < 72 * 3600 * 1000 : false;
  return (
    <Card eyebrow="Developer Mode" title="Session" className="col-4">
      {status.error && (
        <ErrorAlert error={status.error} title="Couldn’t check the session" action={<button type="button" className="btn btn--sm btn--ghost" onClick={() => status.refetch()}>Retry</button>} />
      )}
      {!status.data ? (
        !status.error && <div className="empty-state"><span className="spinner" /><p>Checking…</p></div>
      ) : !status.data.token ? (
        <Alert kind="warning" title="No Developer Mode token">
          The TV has no valid Developer Mode session token. Open the Developer Mode app on the TV and sign in again.
        </Alert>
      ) : (
        <div className="stack">
          {countdown ? (
            <div className="devmode-time">
              <div className={`devmode-countdown mono${low ? ' is-low' : ''}`} role="timer" aria-label="Time left">
                {fmtCountdown(countdown.left)}
              </div>
              <div className="progress thin" role="progressbar" aria-label="Session left" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <div className={`progress-fill${low ? ' danger' : ''}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="muted devmode-ends">
                Ends {countdown.ends.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. The time shown on the TV only updates when it restarts.
              </div>
            </div>
          ) : (
            <Alert kind="warning" title="Time left unknown">{status.data.problem ?? 'LG didn’t say how long is left.'}</Alert>
          )}
          <div className="row">
            <button type="button" className="btn btn--primary" onClick={renew} disabled={renewing || !ready}>
              {renewing ? <span className="spinner sm" /> : <Icon name="refresh" />} Renew now
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setShowAuto(true)}>
              <Icon name="clock" /> Renew automatically…
            </button>
          </div>
        </div>
      )}
      {status.data?.token && <AutoRenewDialog open={showAuto} onClose={() => setShowAuto(false)} device={device} token={status.data.token} />}
    </Card>
  );
}

function CopyBox({ text, label }: { text: string; label: string }) {
  const { toast } = useFeedback();
  return (
    <div className="copybox">
      <code className="mono">{text}</code>
      <button
        type="button"
        className="btn btn--icon btn--sm btn--ghost"
        aria-label={`Copy ${label}`}
        title="Copy"
        onClick={() =>
          navigator.clipboard.writeText(text).then(
            () => toast({ kind: 'success', title: `${label} copied` }),
            () => toast({ kind: 'warning', title: 'Copy failed', text: 'Select the text and copy it by hand.' }),
          )
        }
      >
        <Icon name="copy" />
      </button>
    </div>
  );
}

/** "Automatic Developer Mode Renewal" (RenewScriptComponent): the renew URL, a shell script, or IFTTT. */
function AutoRenewDialog({ open, onClose, device, token }: { open: boolean; onClose: () => void; device: SavedDevice; token: string }) {
  const [tab, setTab] = useState<'url' | 'script' | 'ifttt'>('url');
  const { toast } = useFeedback();
  const url = resetUrl(token);
  const script = useMemo(() => renewScript(device), [device]);
  // Shown with the key hidden until asked: screens get shared and recorded. Copy / download use the full script.
  const [showKey, setShowKey] = useState(false);
  const shownScript = useMemo(() => (showKey ? script : renewScript(device, { redact: true })), [showKey, script, device]);
  const fileName = `renew-devmode-${device.name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'tv'}.sh`;
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Renew Developer Mode automatically">
      <div className="stack">
        <div className="tabs pills" role="group" aria-label="Ways to renew">
          {(
            [
              ['url', 'Renew URL'],
              ['script', 'Shell script'],
              ['ifttt', 'IFTTT'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={tab === id} className={`tab${tab === id ? ' is-active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'url' && (
          <>
            <p>Opening this address renews the session for another 1000 hours. Anything that can open a URL on a schedule can keep Developer Mode alive with it.</p>
            <CopyBox text={url} label="Renew URL" />
            <Alert kind="warning">Anyone with this URL can renew your TV’s session. It changes when you sign in to Developer Mode again.</Alert>
          </>
        )}
        {tab === 'script' &&
          (script ? (
            <>
              <p>
                A shell script for macOS or Linux (or WSL). It logs in to the TV to read the current token, then renews. Run it on a computer on
                the same network as the TV, for example daily with <span className="mono">cron</span> (run it as{' '}
                <span className="mono">sh {fileName}</span>, or <span className="mono">chmod 700</span> it first).
              </p>
              <Alert kind="danger" title="Contains this TV’s private key">Keep the script private — it can log in to the TV.</Alert>
              <pre className="file-preview-text renew-script">{shownScript}</pre>
              <div className="row">
                <button type="button" className="btn btn--ghost" onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>
                  <Icon name="key" /> {showKey ? 'Hide key' : 'Show key'}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() =>
                    navigator.clipboard.writeText(script).then(
                      () => toast({ kind: 'success', title: 'Script copied' }),
                      () => toast({ kind: 'warning', title: 'Copy failed' }),
                    )
                  }
                >
                  <Icon name="copy" /> Copy
                </button>
                <button type="button" className="btn btn--primary" onClick={() => saveBlob(new Blob([script], { type: 'text/x-shellscript' }), fileName)}>
                  <Icon name="download" /> Download {fileName}
                </button>
              </div>
            </>
          ) : (
            <Alert kind="info">
              The script needs the TV’s SSH key in the usual PEM / OpenSSH form, and an address and user name the add-TV form accepts. This TV’s
              saved settings don’t have that — edit the TV, or use the renew URL instead.
            </Alert>
          ))}
        {tab === 'ifttt' && (
          <>
            <Alert kind="warning">IFTTT’s webhook action is no longer free.</Alert>
            <ol className="plain-list numbered">
              <li>
                Create an applet at <a href="https://ifttt.com/create" target="_blank" rel="noopener noreferrer">ifttt.com/create</a>.
              </li>
              <li>Pick <b>Date &amp; Time</b> as the trigger, then <b>Every day at</b> or <b>Every hour at</b>.</li>
              <li>Pick <b>Webhooks</b> as the action, with this URL:</li>
            </ol>
            <CopyBox text={url} label="Renew URL" />
            <p className="muted">Then create the action and save the applet. If it stops working, open this page again for the new URL.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

function HomebrewCard({ device }: { device: SavedDevice }) {
  const apps = useInstalledApps(device);
  const hb = useHbChannel(device);
  const repo = useRepoIndex();
  const ops = useAppOperations(device, apps.data);
  const qc = useQueryClient();
  const installed = apps.data?.find((a) => a.id === APP_ID_HBCHANNEL);
  const pkg = repo.byId.get(APP_ID_HBCHANNEL);
  const update = installed && pkg?.manifest ? hasUpdate(pkg.manifest.version, installed.version) === true : false;

  return (
    <Card eyebrow="Homebrew" title="Homebrew Channel" className="col-4">
      {apps.error ? (
        <ErrorAlert error={apps.error} title="Couldn’t read the installed apps" />
      ) : !apps.data ? (
        <div className="empty-state"><span className="spinner" /></div>
      ) : (
        <div className="stack">
          <dl className="kv">
            <dt>Installed</dt>
            <dd>{installed ? <span className="mono">v{installed.version}</span> : 'No'}</dd>
            <dt>Root</dt>
            <dd>{hb.data ? (hb.data.root ? <span className="badge success">Rooted</span> : <span className="badge">Not rooted</span>) : '—'}</dd>
            {pkg?.manifest && (
              <>
                <dt>Latest</dt>
                <dd className="mono">v{pkg.manifest.version}</dd>
              </>
            )}
          </dl>
          <div className="row">
            {pkg?.manifest && (!installed || update) && (
              <button
                type="button"
                className="btn btn--primary"
                disabled={ops.busy}
                onClick={async () => {
                  await ops.installFromRepo(pkg, { update: !!installed });
                  qc.invalidateQueries({ queryKey: ['hbchannel', device.id] });
                }}
              >
                <Icon name="download" /> {installed ? `Update to v${pkg.manifest.version}` : 'Install'}
              </button>
            )}
            <a className="btn btn--ghost" href="https://github.com/webosbrew/webos-homebrew-channel" target="_blank" rel="noopener noreferrer">
              <Icon name="github" /> GitHub
            </a>
          </div>
        </div>
      )}
      {ops.dialog}
    </Card>
  );
}
