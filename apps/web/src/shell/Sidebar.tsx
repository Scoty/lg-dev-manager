import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { RAIL_QUERY, useMedia } from '../lib/useMedia';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Icon } from './icons';
import { NAV, type NavItem } from './nav';
import { APP_VERSION } from '../lib/version';
import { DeviceSwitcher } from './DeviceSwitcher';

function NavGroup({ item, pathname }: { item: NavItem; pathname: string }) {
  const containsActive = item.children!.some((c) => pathname.startsWith(c.to));
  const [open, setOpen] = useState(containsActive);
  const rail = useMedia(RAIL_QUERY);
  // In the icon rail the submenu is a flyout: it opens on click only, next to its icon, and closes again.
  const [flyout, setFlyout] = useState<{ top: number; left: number } | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const isOpen = rail ? !!flyout : open || containsActive;

  useEffect(() => setFlyout(null), [pathname, rail]);
  useEffect(() => {
    if (!flyout) return;
    const outside = (e: PointerEvent) => !group.current?.contains(e.target as Node) && setFlyout(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setFlyout(null);
    const close = () => setFlyout(null);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', close);
    };
  }, [flyout]);

  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    if (!rail) return setOpen(!isOpen);
    if (flyout) return setFlyout(null);
    const r = e.currentTarget.getBoundingClientRect();
    // Shifted up when it would run off the bottom (about 40px per entry).
    const height = item.children!.length * 40 + 14;
    setFlyout({ top: Math.max(8, Math.min(r.top, window.innerHeight - height - 8)), left: r.right + 10 });
  };

  return (
    <div ref={group} className={`nav-item-group${isOpen ? ' is-open' : ''}`}>
      <button
        type="button"
        className={`nav-link${rail && containsActive ? ' is-active' : ''}`}
        aria-expanded={isOpen}
        aria-label={rail ? item.text : undefined}
        title={rail ? item.text : undefined}
        onClick={toggle}
      >
        <Icon name={item.icon} />
        <span>{item.text}</span>
        <Icon name="chevRight" className="chev" strokeWidth={1.8} />
      </button>
      <div className="nav-submenu" style={rail && flyout ? flyout : undefined}>
        {item.children!.map((c) => (
          <NavLink key={c.key} to={c.to} className={({ isActive }) => (isActive ? 'is-active' : undefined)}>
            {c.text}
          </NavLink>
        ))}
      </div>
    </div>
  );
}

function NavEntry({ item, pathname }: { item: NavItem; pathname: string }) {
  const rail = useMedia(RAIL_QUERY);
  if (item.children) return <NavGroup item={item} pathname={pathname} />;
  // The rail shows icons only, so the name moves to a tooltip and the accessible name.
  const named = rail ? { title: item.text, 'aria-label': item.text } : {};
  const inner = (
    <>
      <Icon name={item.icon} />
      <span>{item.text}</span>
      {item.badge && <span className={`nav-badge ${item.badge.kind}`}>{item.badge.text}</span>}
    </>
  );
  if (item.href) {
    return (
      <a className="nav-link" href={item.href} target="_blank" rel="noopener noreferrer" {...named}>
        {inner}
      </a>
    );
  }
  return (
    <NavLink to={item.to!} className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`} {...named}>
      {inner}
    </NavLink>
  );
}

export function Sidebar() {
  const { pathname } = useLocation();
  return (
    <aside className="d-sidebar">
      <Link to="/" className="brand">
        <div className="brand-logo">
          <Icon name="tv" strokeWidth={2} />
        </div>
        <div className="brand-text">
          <div className="brand-name">LG Dev Manager</div>
          <div className="brand-tag">v{APP_VERSION}</div>
        </div>
      </Link>

      {NAV.map((section) => (
        <nav className="nav-section" key={section.label}>
          <div className="nav-label">{section.label}</div>
          {section.items.map((item) => (
            <NavEntry key={item.key} item={item} pathname={pathname} />
          ))}
        </nav>
      ))}

      <div className="sidebar-footer">
        <DeviceSwitcher />
      </div>
    </aside>
  );
}
