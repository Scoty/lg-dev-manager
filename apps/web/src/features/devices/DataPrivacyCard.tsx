import { useEffect, useRef, useState } from 'react';
import { Card } from '../../components/Card';
import { Alert } from '../../components/Alert';
import { Icon } from '../../shell/icons';
import { BackupError, clearAllDevices, exportDevices, importDevices, listBrowserDevices, moveBrowserDataToBridge, newCustomReposIn, subscribe } from '../../devices/store';
import { loadBrowserRepos, moveBrowserReposToBridge } from '../../repos/store';
import { moveBrowserShotsToBridge } from '../info/shots';
import { useStorageMode } from '../../storage/backend';
import { useBridge } from '../../bridge/BridgeProvider';
import { saveBlob } from '../files/transfer';
import { useDevices } from '../../devices/useDevices';
import { useFeedback } from '../../components/Feedback';
import { count } from '../../lib/format';

/** Shows where device settings live and lets the user back them up, move them, or wipe them. */
export function DataPrivacyCard() {
  const mode = useStorageMode();
  return mode === 'bridge' ? <StoredOnBridgeCard /> : <InThisBrowserCard />;
}

/**
 * The bridge stores the TVs (2.0, --store; the Docker image): say where they are and what browsers never get back, and
 * offer to move this browser's own TVs (from before) there.
 */
function StoredOnBridgeCard() {
  const { status } = useBridge();
  const { confirm } = useFeedback();
  const [own, setOwn] = useState<{ tvs: number; repos: number }>({ tvs: 0, repos: 0 });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const connected = status.state === 'connected';

  useEffect(() => {
    let alive = true;
    const check = () =>
      listBrowserDevices()
        .then((d) => alive && setOwn({ tvs: d.filter((x) => x.auth).length, repos: loadBrowserRepos().length }))
        .catch(() => {});
    check();
    const off = subscribe(check);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const move = async () => {
    const ok = await confirm({
      title: 'Move this browser’s TVs to the bridge?',
      message: `${count(own.tvs, 'TV')} (with their logins and screenshots)${own.repos ? ` and ${count(own.repos, 'custom repository', 'custom repositories')}` : ''} will be copied to the bridge, then removed from this browser. Every browser paired with the bridge will see them. The bridge keeps the logins and never sends them back.`,
      confirmText: 'Move them',
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const { tvs: n, shotsLeft } = await moveBrowserDataToBridge(moveBrowserShotsToBridge, async () => void (await moveBrowserReposToBridge()));
      setMsg(
        shotsLeft
          ? { kind: 'warning', text: `Moved ${count(n, 'TV')} to the bridge. ${count(shotsLeft, 'screenshot')} couldn’t be moved and stayed in this browser.` }
          : { kind: 'success', text: `Moved ${count(n, 'TV')} to the bridge.` },
      );
    } catch (e) {
      setMsg({ kind: 'danger', text: `Nothing was removed from this browser: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (file: File) => {
    try {
      const json: unknown = JSON.parse(await file.text());
      const repos = newCustomReposIn(json);
      const withRepos = repos.length > 0 && (await confirm({ title: 'Also add its custom repositories?', message: 'This backup also lists unofficial app repositories. They can contain untested apps or malware — add them only if you trust where the backup came from.', confirmText: 'Add them too', cancelText: 'Only the TVs' }));
      const n = await importDevices(json, { customRepos: withRepos });
      setMsg({ kind: 'success', text: `Imported ${count(n, 'TV')} to the bridge.` });
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof BackupError ? e.message : 'That file is not an LG Dev Manager device backup.' });
    }
  };

  return (
    <Card eyebrow="Privacy" title="Your TVs are stored on the bridge" className="col-12">
      <div className="stack">
        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
          This bridge keeps the TVs — names, addresses, logins — and their screenshots and the custom repositories in its data
          folder, readable only by the bridge, so every browser paired with it sees the same ones. A TV’s password or key goes
          to the bridge when you add or change the TV and is never sent back to any browser. To back them up, back up the
          bridge’s data folder (the <span className="mono">/data</span> volume in Docker).
        </p>
        {(own.tvs > 0 || own.repos > 0) && (
          <Alert
            kind="info"
            title={`This browser also has ${[own.tvs ? `${count(own.tvs, 'TV')}` : '', own.repos ? `${count(own.repos, 'custom repository', 'custom repositories')}` : ''].filter(Boolean).join(' and ')} of its own`}
            action={
              <button type="button" className="btn btn--sm btn--primary" onClick={move} disabled={!connected || busy}>
                {busy ? 'Moving…' : 'Move to the bridge'}
              </button>
            }
          >
            Saved here before this bridge stored them. They aren’t shown above until they’re moved.
          </Alert>
        )}
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <div className="row">
          <button className="btn btn--ghost" onClick={() => fileRef.current?.click()} disabled={!connected}>
            <Icon name="plus" /> Import a backup to the bridge
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) doImport(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>
    </Card>
  );
}

function InThisBrowserCard() {
  const { devices } = useDevices();
  const { confirm } = useFeedback();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  const doExport = async () => {
    const ok = await confirm({
      title: 'Download a backup?',
      message: 'The backup file contains your TVs’ private keys and passwords. Keep it somewhere safe and don’t share it.',
      confirmText: 'Download',
    });
    if (!ok) return;
    const blob = new Blob([JSON.stringify(await exportDevices(), null, 2)], { type: 'application/json' });
    saveBlob(blob, `lg-dev-manager-devices-${new Date().toISOString().slice(0, 10)}.json`);
  };

  const doImport = async (file: File) => {
    try {
      const json: unknown = JSON.parse(await file.text());
      // Custom repositories in a backup are only added once the user has seen them and the warning — a backup can
      // come from someone else, and a repository can carry malware.
      const repos = newCustomReposIn(json);
      const withRepos =
        repos.length > 0 &&
        (await confirm({
          title: `Also add ${repos.length === 1 ? 'a custom repository' : `${repos.length} custom repositories`}?`,
          message: (
            <>
              <p style={{ marginTop: 0 }}>
                This backup also lists unofficial app repositories. They can contain untested apps or malware — add them
                only if you trust where the backup came from.
              </p>
              <ul style={{ marginBottom: 0 }}>
                {repos.map((r) => (
                  <li key={r.id}>
                    <b>{r.name}</b> — <span className="mono">{r.url}</span>
                  </li>
                ))}
              </ul>
            </>
          ),
          confirmText: 'Add them too',
          cancelText: 'Only the TVs',
        }));
      const n = await importDevices(json, { customRepos: withRepos });
      setMsg({
        kind: 'success',
        text: `Imported ${count(n, 'device')}${withRepos ? ` and ${count(repos.length, 'custom repository', 'custom repositories')}` : ''}.`,
      });
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof BackupError ? e.message : 'That file is not an LG Dev Manager device backup.' });
    }
  };

  const doClear = async () => {
    const ok = await confirm({
      title: 'Remove all TVs from this browser?',
      message: 'Every saved TV, key and password is deleted from this browser. Nothing on the TVs changes. This can’t be undone.',
      confirmText: 'Remove all',
      danger: true,
    });
    if (!ok) return;
    await clearAllDevices();
    setMsg({ kind: 'success', text: 'All device settings were removed from this browser.' });
  };

  return (
    <Card eyebrow="Privacy" title="Your device settings stay in this browser" className="col-12">
      <div className="stack">
        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
          TV names, addresses, keys and passwords are saved only in this browser's storage for{' '}
          <span className="mono">{window.location.host}</span>. They are never uploaded to this website. They are sent only to
          your paired bridge when it connects to a TV, and the bridge keeps them in memory, never on disk. Other browsers and
          other copies of this app (for example the one the bridge serves at localhost:5199) have their own separate list — use export and import to move it.
        </p>
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <div className="row">
          <button className="btn btn--ghost" onClick={doExport} disabled={!devices?.length}>
            <Icon name="files" /> Export backup
          </button>
          <button className="btn btn--ghost" onClick={() => fileRef.current?.click()}>
            <Icon name="plus" /> Import backup
          </button>
          <button className="btn btn--outline-danger" onClick={doClear} disabled={!devices?.length}>
            Remove all from this browser
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) doImport(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>
    </Card>
  );
}
