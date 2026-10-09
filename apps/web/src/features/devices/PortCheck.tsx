import { DEVMODE_SSH_PORT, KEY_SERVER_PORT, ROOT_SSH_PORT, type ResultOf } from '@lgdm/protocol';
import { Alert } from '../../components/Alert';
import type { SetupMode } from './auth';

export type PortResult = ResultOf<'device.checkConnection'>;

const PORTS = [
  { key: 'webos', label: 'webOS TV', port: 3000 },
  { key: 'ssh22', label: 'Root SSH', port: ROOT_SSH_PORT },
  { key: 'ssh9922', label: 'Dev Mode SSH', port: DEVMODE_SSH_PORT },
  { key: 'keyServer', label: 'Key server', port: KEY_SERVER_PORT },
] as const;

/**
 * The TV answers but Homebrew Channel's SSH server is off. It only starts at boot, so the TV must be restarted
 * after turning it on.
 */
export function SshOffHint() {
  return (
    <Alert kind="warning" title="This is an LG TV, but its SSH server is off">
      <ol className="hint-steps">
        <li>On the TV, open <b>Homebrew Channel</b> → <b>Settings</b>.</li>
        <li>Turn on <b>SSH Server</b>.</li>
        <li>
          <b>Restart the TV</b> — the SSH server only starts when the TV boots. Use Settings → General → Restart, or unplug it for
          a few seconds (just switching it off with the remote may not be enough).
        </li>
        <li>Come back here and press <b>Check</b> again.</li>
      </ol>
      If Homebrew Channel isn’t installed, the TV isn’t rooted — choose <b>Developer Mode</b> instead.
    </Alert>
  );
}

/** Port chips plus the hint that fits what's closed (conn-hint / keyserver-hint in the original). */
export function PortCheck({ result, checking, mode, port }: { result: PortResult | null; checking: boolean; mode: SetupMode; port: number }) {
  if (!result && !checking) return null;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="port-chips" aria-live="polite">
        {PORTS.map((p) => {
          const open = result?.[p.key];
          const cls = checking ? 'is-checking' : open ? 'is-open' : 'is-closed';
          return (
            <span key={p.key} className={`port-chip ${cls}`}>
              <span className="dot" aria-hidden="true" />
              {p.label} <span className="mono">{p.port}</span>
              <span className="sr-only">{checking ? 'checking' : open ? 'open' : 'closed'}</span>
            </span>
          );
        })}
      </div>
      {result && !checking && <PortHint result={result} mode={mode} port={port} />}
    </div>
  );
}

function PortHint({ result, mode, port }: { result: PortResult; mode: SetupMode; port: number }) {
  const anyOpen = result.ssh22 || result.ssh9922 || result.keyServer || result.webos;
  if (!anyOpen) {
    return (
      <Alert kind="warning" title="The TV didn’t answer">
        Check the address, make sure the TV is on and on the same network as this computer
        {mode === 'devmode' ? ', and that Developer Mode is installed and turned on.' : '.'}
      </Alert>
    );
  }
  if (mode === 'devmode') {
    if (!result.ssh9922) {
      return (
        <Alert kind="warning" title="Developer Mode SSH isn’t answering">
          Open the Developer Mode app and check that <b>Dev Mode Status</b> is ON. The TV restarts when you turn it on.
        </Alert>
      );
    }
    if (!result.keyServer) {
      return (
        <Alert kind="warning" title="Key Server is off">
          Turn on <b>Key Server</b> in the Developer Mode app while adding the TV. If it is already on, try turning it off and on
          again.
        </Alert>
      );
    }
    return <Alert kind="success" title="Ready">Developer Mode SSH and the key server both answer.</Alert>;
  }
  if (mode === 'rooted' && !result.ssh22) {
    if (result.webos) return <SshOffHint />;
    return (
      <Alert kind="warning" title="SSH on port 22 isn’t answering">
        Turn on <b>SSH Server</b> in the Homebrew Channel settings on the TV, then restart the TV.
      </Alert>
    );
  }
  if (mode === 'rooted') {
    return <Alert kind="success" title="Ready">Homebrew Channel’s SSH server answers on port 22.</Alert>;
  }
  if (mode === 'manual' && port === ROOT_SSH_PORT && !result.ssh22 && result.webos) return <SshOffHint />;
  if (mode === 'manual' && port !== ROOT_SSH_PORT && port !== DEVMODE_SSH_PORT) {
    return <Alert kind="info">Port {port} isn’t one of the usual ones, so it wasn’t checked. Continue to test the login.</Alert>;
  }
  return null;
}
