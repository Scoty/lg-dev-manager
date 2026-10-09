import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ICONS, type IconName } from './icons';
import { NAV } from './nav';
import { toggleTheme } from '../lib/theme';

interface PaletteItem {
  label: string;
  section: string;
  icon: IconName;
  run: () => void;
}

function score(item: PaletteItem, q: string): number {
  if (!q) return 1;
  const label = item.label.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 50;
  if (label.includes(q)) return 20;
  if (item.section.toLowerCase().includes(q)) return 5;
  return 0;
}

/** ⌘K / Ctrl+K palette — port of Adminator's palette.js, built from the same NAV manifest. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [];
    for (const section of NAV) {
      for (const item of section.items) {
        if (item.children) {
          for (const c of item.children) {
            list.push({ label: c.text, section: `${section.label} › ${item.text}`, icon: item.icon, run: () => navigate(c.to) });
          }
        } else if (item.to) {
          list.push({ label: item.text, section: section.label, icon: item.icon, run: () => navigate(item.to!) });
        } else if (item.href) {
          list.push({ label: item.text, section: 'External', icon: item.icon, run: () => window.open(item.href, '_blank', 'noopener') });
        }
      }
    }
    list.push({ label: 'Toggle theme (light / dark)', section: 'Action', icon: 'sun', run: () => toggleTheme() });
    list.push({ label: 'Add a device', section: 'Action', icon: 'plus', run: () => navigate('/devices') });
    return list;
  }, [navigate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .map((item) => ({ item, s: score(item, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((x) => x.item);
  }, [items, query]);

  useEffect(() => {
    document.body.classList.toggle('has-palette-open', open);
    if (open) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    return () => document.body.classList.remove('has-palette-open');
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  if (!open) return null;

  const activate = (item?: PaletteItem) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="palette-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            activate(filtered[cursor]);
          }
        }}
      >
        <div className="palette-input-row">
          <svg viewBox="0 0 24 24" className="palette-icon" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            className="palette-input"
            type="text"
            placeholder="Search pages, actions…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search"
          />
          <kbd className="palette-esc">esc</kbd>
        </div>
        <div className="palette-results" role="listbox">
          {filtered.length === 0 ? (
            <div className="palette-empty">No results</div>
          ) : (
            filtered.map((item, i) => (
              <div
                key={`${item.section}/${item.label}`}
                className={`palette-result${i === cursor ? ' is-selected' : ''}`}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => activate(item)}
              >
                <span className="palette-result-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} dangerouslySetInnerHTML={{ __html: ICONS[item.icon] }} />
                </span>
                <span className="palette-result-label">{item.label}</span>
                <span className="palette-result-section">{item.section}</span>
              </div>
            ))
          )}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
