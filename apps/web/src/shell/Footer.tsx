import { APP_VERSION } from '../lib/version';
import { useBridge } from '../bridge/BridgeProvider';

export function Footer() {
  const { status } = useBridge();
  return (
    <footer className="d-footer">
      <div>
        Based on{' '}
        <a href="https://github.com/webosbrew/dev-manager-desktop" target="_blank" rel="noopener noreferrer">
          webOS Dev Manager
        </a>{' '}
        · design by{' '}
        <a href="https://github.com/puikinsh/adminator-admin-dashboard" target="_blank" rel="noopener noreferrer">
          Adminator
        </a>
      </div>
      <div className="d-footer-meta">
        <span>web v{APP_VERSION}</span>
        <span>{status.state === 'connected' ? `bridge v${status.bridgeVersion}` : 'no bridge'}</span>
      </div>
    </footer>
  );
}
