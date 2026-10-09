import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Icon } from './icons';
import { NAV, type NavItem } from './nav';
import { APP_VERSION } from '../lib/version';

function NavGroup({ item, pathname }: { item: NavItem; pathname: string }) {
  const containsActive = item.children!.some((c) => pathname.startsWith(c.to));
  const [open, setOpen] = useState(containsActive);
  const isOpen = open || containsActive;
  return (
    <div className={`nav-item-group${isOpen ? ' is-open' : ''}`}>
      <button type="button" className="nav-link" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        <Icon name={item.icon} />
        <span>{item.text}</span>
        <Icon name="chevRight" className="chev" strokeWidth={1.8} />
      </button>
      <div className="nav-submenu">
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
  if (item.children) return <NavGroup item={item} pathname={pathname} />;
  const inner = (
    <>
      <Icon name={item.icon} />
      <span>{item.text}</span>
      {item.badge && <span className={`nav-badge ${item.badge.kind}`}>{item.badge.text}</span>}
    </>
  );
  if (item.href) {
    return (
      <a className="nav-link" href={item.href} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  }
  return (
    <NavLink to={item.to!} className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}>
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
          <div className="brand-tag">v{APP_VERSION} · preview</div>
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
        {/* Device chooser — wired to the device list in M3. */}
        <Link to="/devices" className="workspace" title="Choose device">
          <div className="workspace-avatar">
            <Icon name="tv" />
          </div>
          <div className="workspace-text">
            <div className="workspace-name">No device</div>
            <div className="workspace-role">add a TV to start</div>
          </div>
          <Icon name="updown" className="workspace-chev" strokeWidth={1.8} />
        </Link>
      </div>
    </aside>
  );
}
