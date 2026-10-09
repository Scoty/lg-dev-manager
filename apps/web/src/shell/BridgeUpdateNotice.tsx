import { useState } from 'react';
import gt from 'semver/functions/gt';
import valid from 'semver/functions/valid';
import { Alert } from '../components/Alert';
import { useBridge } from '../bridge/BridgeProvider';
import { BRIDGE_RELEASE } from '../lib/version';

const KEY = 'lgdm-bridge-update-dismissed';

/** True when the connected bridge is older than the one released with this site. */
export function bridgeOutdated(running: string, release = BRIDGE_RELEASE): boolean {
  return !!valid(running) && !!valid(release) && gt(release, running);
}

/**
 * The bridge is updated separately from the site (lg.scoty.uk updates itself; a running bridge doesn't). When it is
 * behind, say how to update. Hidden for the browser session once dismissed, per version.
 */
export function BridgeUpdateNotice({ always = false }: { always?: boolean }) {
  const { status } = useBridge();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  if (status.state !== 'connected' || !bridgeOutdated(status.bridgeVersion)) return null;
  if (!always && dismissed === BRIDGE_RELEASE) return null;
  const hide = () => {
    setDismissed(BRIDGE_RELEASE);
    try {
      sessionStorage.setItem(KEY, BRIDGE_RELEASE);
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div className="page-notice">
      <Alert
        kind="info"
        title={`Bridge v${BRIDGE_RELEASE} is available`}
        action={
          always ? undefined : (
            <button type="button" className="btn btn--sm btn--ghost" onClick={hide}>
              Later
            </button>
          )
        }
      >
        Yours is v{status.bridgeVersion}. Stop it (Ctrl+C) and start it again with{' '}
        <span className="mono">npx lg-dev-manager-bridge@latest</span> — or, if you run it from the repository,{' '}
        <span className="mono">git pull</span>, <span className="mono">pnpm install</span>, <span className="mono">pnpm build</span> and{' '}
        <span className="mono">pnpm bridge</span>. Your pairing stays the same.
      </Alert>
    </div>
  );
}
