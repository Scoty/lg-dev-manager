import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { Footer } from './Footer';
import { CommandPalette } from './CommandPalette';
import { ConsoleDock } from '../console/ConsoleDock';
import { useTvInfoRefresh } from '../devices/useTvInfoRefresh';
import { PhoneNotice } from './PhoneNotice';
import { BridgeUpdateNotice } from './BridgeUpdateNotice';

export function Layout() {
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const { pathname } = useLocation();
  useTvInfoRefresh();

  // Mobile drawer: Adminator's CSS reacts to body.has-drawer-open.
  useEffect(() => {
    document.body.classList.toggle('has-drawer-open', drawer);
  }, [drawer]);
  useEffect(() => setDrawer(false), [pathname]);

  const onKey = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setPalette((p) => !p);
    } else if (e.key === '/' && !typing) {
      e.preventDefault();
      setPalette(true);
    } else if (e.key === 'Escape') {
      setDrawer(false);
    }
  }, []);
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return (
    <div className="shell">
      <Sidebar />
      <div className="drawer-backdrop" onClick={() => setDrawer(false)} />
      <div className="main">
        <Topbar onOpenDrawer={() => setDrawer(true)} onOpenPalette={() => setPalette(true)} />
        <main className="content">
          {!pathname.startsWith('/bridge') && (
            <>
              <PhoneNotice />
              <BridgeUpdateNotice />
            </>
          )}
          <Outlet />
        </main>
        <Footer />
        <ConsoleDock />
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
