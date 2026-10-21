import { useState } from 'react';
import { Alert } from '../components/Alert';
import { useBridge } from '../bridge/BridgeProvider';

const KEY = 'lgdm-lan-notice-dismissed';

/**
 * LAN mode over plain HTTP (the Docker image on a home server): what this page sends the bridge — TV keys and
 * passwords included — crosses the network unencrypted. Said once per browser (and always on the Bridge page).
 */
export function LanNotice({ always = false }: { always?: boolean }) {
  const { status } = useBridge();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  if (status.state !== 'connected' || !status.lan || window.location.protocol !== 'http:') return null;
  if (!always && dismissed) return null;
  const hide = () => {
    setDismissed(true);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div className="page-notice">
      <Alert
        kind="warning"
        title="This bridge is shared on your network over plain HTTP"
        action={
          always ? undefined : (
            <button type="button" className="btn btn--sm btn--ghost" onClick={hide}>
              Got it
            </button>
          )
        }
      >
        The TV keys and passwords this page uses travel unencrypted between this device and{' '}
        <span className="mono">{window.location.host}</span>. That’s fine on a home network you trust; otherwise put the
        bridge behind an HTTPS reverse proxy. Never make it reachable from the internet.
      </Alert>
    </div>
  );
}
