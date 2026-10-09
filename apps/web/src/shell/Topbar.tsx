import { Link, useLocation } from 'react-router-dom';
import { Fragment, useState } from 'react';
import { Icon } from './icons';
import { crumbsFor } from './nav';
import { getTheme, toggleTheme, type Theme } from '../lib/theme';
import { useBridge } from '../bridge/BridgeProvider';

function BridgePill() {
  const { status } = useBridge();
  const map = {
    unpaired: { cls: '', text: 'Bridge not set up' },
    connecting: { cls: ' is-connecting', text: 'Connecting…' },
    connected: { cls: ' is-connected', text: 'Bridge connected' },
    error: { cls: ' is-error', text: 'Bridge offline' },
  } as const;
  const { cls, text } = map[status.state];
  return (
    <Link to="/bridge" className={`bridge-pill${cls}`} title={status.state === 'error' ? status.message : text}>
      <span className="dot" aria-hidden="true" />
      <span>{text}</span>
    </Link>
  );
}

export function Topbar({ onOpenDrawer, onOpenPalette }: { onOpenDrawer: () => void; onOpenPalette: () => void }) {
  const { pathname } = useLocation();
  const crumbs = crumbsFor(pathname);
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <header className="d-topbar">
      <div className="crumbs">
        <button className="hamburger" onClick={onOpenDrawer} aria-label="Open navigation">
          <Icon name="menu" strokeWidth={2} />
        </button>
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <Icon name="chevRight" className="sep" strokeWidth={2} />}
            <span className={i === crumbs.length - 1 ? 'current' : undefined}>{c}</span>
          </Fragment>
        ))}
      </div>
      <div className="topbar-actions">
        <button className="cmd" onClick={onOpenPalette}>
          <Icon name="search" />
          <span>Search...</span>
          <kbd className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <BridgePill />
        <button
          className="icon-btn"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          onClick={() => setThemeState(toggleTheme())}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  );
}
