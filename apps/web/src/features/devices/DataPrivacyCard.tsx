import { useRef, useState } from 'react';
import { Card } from '../../components/Card';
import { Alert } from '../../components/Alert';
import { Icon } from '../../shell/icons';
import { clearAllDevices, exportDevices, importDevices } from '../../devices/store';
import { useDevices } from '../../devices/useDevices';

/** Shows where device settings live and lets the user back them up, move them, or wipe them. */
export function DataPrivacyCard() {
  const { devices } = useDevices();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  const doExport = async () => {
    if (!confirm('The backup file contains your TVs’ private keys and passwords. Keep it somewhere safe. Download it?')) return;
    const blob = new Blob([JSON.stringify(await exportDevices(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lg-dev-manager-devices-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = async (file: File) => {
    try {
      const n = await importDevices(JSON.parse(await file.text()));
      setMsg({ kind: 'success', text: `Imported ${n} device${n === 1 ? '' : 's'}.` });
    } catch {
      setMsg({ kind: 'danger', text: 'That file is not an LG Dev Manager device backup.' });
    }
  };

  const doClear = async () => {
    if (!confirm('Remove every saved TV, key and password from this browser? This cannot be undone.')) return;
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
          other copies of this app (for example one served from your NAS) have their own separate list — use export and import to move it.
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
