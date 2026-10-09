import { useState, type FormEvent } from 'react';
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_BRIDGE_PORT, REPO_URL } from '@lgdm/protocol';
import { PageHeader } from '../../components/PageHeader';
import { PhoneNotice } from '../../shell/PhoneNotice';
import { Card } from '../../components/Card';
import { Icon } from '../../shell/icons';
import { useBridge } from '../../bridge/BridgeProvider';
import { defaultBridgeUrl } from '../../bridge/settings';
import { BridgeError } from '../../bridge/client';
import { Alert } from '../../components/Alert';

function StatusAlert() {
  const { status, reconnect } = useBridge();
  switch (status.state) {
    case 'connected':
      return <Alert kind="success" title="Connected">Bridge v{status.bridgeVersion} on {status.platform}.</Alert>;
    case 'connecting':
      return <Alert kind="info" title="Connecting…">Trying to reach the bridge.</Alert>;
    case 'error':
      return (
        <Alert
          kind="danger"
          title="Not connected"
          action={<button type="button" className="btn btn--sm btn--ghost" onClick={reconnect}>Retry</button>}
        >
          {status.message}
        </Alert>
      );
    default:
      return <Alert kind="warning" title="Not paired yet">Start the bridge, then paste its pairing token below.</Alert>;
  }
}

export function BridgePage() {
  const { settings, pair, forget } = useBridge();
  const [url, setUrl] = useState(settings?.url ?? defaultBridgeUrl());
  const [token, setToken] = useState(settings?.token ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BridgeError | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await pair({ url: url.trim(), token: token.trim() });
    } catch (err) {
      setError(err instanceof BridgeError ? err : new BridgeError('unknown', String(err)));
    } finally {
      setBusy(false);
    }
  };

  const origin = window.location.origin;

  return (
    <>
      <PageHeader
        eyebrow="Setup"
        title="Connect the"
        accent="bridge"
        sub="Browsers can't open SSH connections to your TV, so a small helper runs on your computer and does it for this page. It only accepts this website and needs a pairing token."
      />
      {/* On the setup page the phone warning can't be dismissed: this is where people try to make it work. */}
      <PhoneNotice always />
      <div className="grid">
        <Card eyebrow="Step 1" title="Run the bridge" className="col-6">
          <div className="stack">
            <div>
              <div className="eyebrow">In a terminal on this computer (Node 22+ and pnpm)</div>
              <div className="codeblock">{`git clone ${REPO_URL}.git
cd lg-dev-manager
pnpm install
pnpm dev:bridge`}</div>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              On macOS, the first time the bridge looks for or connects to your TV, the system asks whether your terminal app may
              find devices on your local network — choose <strong>Allow</strong>.
            </p>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              The bridge prints a <strong>pairing token</strong> when it starts — paste it below. Already cloned? Run{' '}
              <span className="mono">git pull</span> and <span className="mono">pnpm install</span> first so the bridge matches this
              site. No pnpm? Run <span className="mono">corepack enable</span> once. (A one-line{' '}
              <span className="mono">npx lg-dev-manager-bridge</span> comes with the v1.0 release.)
            </p>
            {!(DEFAULT_ALLOWED_ORIGINS as readonly string[]).includes(origin) &&
              !origin.endsWith(`:${DEFAULT_BRIDGE_PORT}`) && (
                <Alert kind="warning">
                  This page is served from <span className="mono">{origin}</span>. Start the bridge with{' '}
                  <span className="mono">--allow-origin {origin}</span> so it accepts this site.
                </Alert>
              )}
          </div>
        </Card>

        <Card eyebrow="Step 2" title="Pair this browser" className="col-6">
          <form className="stack" onSubmit={onSubmit}>
            <StatusAlert />
            <div className="field">
              <label className="field-label" htmlFor="bridge-url">Bridge address</label>
              <input id="bridge-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} required />
              <span className="field-help">Default: {defaultBridgeUrl()}</span>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="bridge-token">Pairing token</label>
              <input
                id="bridge-token"
                className="input mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Printed by the bridge on startup"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            {error && (
              <Alert kind="danger" title="Pairing failed">{error.message}</Alert>
            )}
            <div className="row">
              <button className="btn btn--primary" disabled={busy} type="submit">
                <Icon name="key" /> {busy ? 'Pairing…' : 'Pair'}
              </button>
              {settings && (
                <button type="button" className="btn btn--ghost" onClick={forget}>Forget this bridge</button>
              )}
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
