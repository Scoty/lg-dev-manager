import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const GAP = 6;
const EDGE = 8;

/** Bottom of the usable viewport: the top of the console dock when it's showing. */
function viewportBottom() {
  const dock = document.querySelector('.console-dock');
  const top = dock?.getBoundingClientRect().top;
  return top && top > 0 ? Math.min(top, window.innerHeight) : window.innerHeight;
}

/**
 * Adminator `.dd-wrap` / `.dd-menu` with click-outside and Escape. `children` receives `close` so menu items
 * can dismiss it.
 *
 * `floating` renders the menu on top of the page (fixed, in a portal), lined up with the trigger and opening
 * upwards when there's no room below (scrolling when it fits neither way, never under the console) — for menus inside
 * scrolling containers like tables, which would otherwise clip it, and long menus.
 */
export function Dropdown({
  trigger,
  children,
  placement = 'down-right',
  className = '',
  menuClassName = '',
  label,
  floating = false,
}: {
  trigger: (props: { open: boolean; toggle: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: 'down-right' | 'down-left' | 'up-left';
  className?: string;
  menuClassName?: string;
  label: string;
  floating?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);

  const place = useCallback(() => {
    const anchor = ref.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    // The menu's full height (scrollHeight, whatever height it was given last time) decides where it fits; when it
    // fits neither way, it gets the bigger side and scrolls.
    const h = menu.scrollHeight;
    const w = menu.offsetWidth;
    const bottom = viewportBottom();
    const below = bottom - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const up = h > below && above > below;
    const maxHeight = Math.max(120, up ? above : below);
    const top = up ? Math.max(EDGE, anchor.top - GAP - Math.min(h, maxHeight)) : anchor.bottom + GAP;
    const left =
      placement === 'down-right'
        ? Math.max(EDGE, anchor.right - w)
        : Math.min(Math.max(EDGE, anchor.left), window.innerWidth - w - EDGE);
    setPos((p) => (p && p.top === top && p.left === left && p.maxHeight === maxHeight ? p : { top, left, maxHeight, overflowY: 'auto' }));
  }, [placement]);

  useLayoutEffect(() => {
    if (!floating) return;
    if (!open) return setPos(null);
    place();
  }, [floating, open, place]);
  // Again after every render while open: the menu's content (and so its height) can change as items are chosen.
  useLayoutEffect(() => {
    if (floating && open) place();
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // A floating menu follows its trigger when anything scrolls or the window resizes.
    if (floating) {
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
    }
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, floating, place]);

  const items = open && children(() => setOpen(false));

  return (
    <div ref={ref} className={`dd-wrap${open ? ' is-open' : ''} ${className}`}>
      {trigger({ open, toggle: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {floating ? (
        open &&
        createPortal(
          <div
            ref={menuRef}
            className={`dd-menu dd-menu--floating${pos ? ' is-placed' : ''} ${menuClassName}`}
            role="menu"
            aria-label={label}
            style={pos ?? undefined}
          >
            {items}
          </div>,
          document.body,
        )
      ) : (
        <div ref={menuRef} className={`dd-menu dd-menu--${placement} ${menuClassName}`} role="menu" aria-label={label}>
          {items}
        </div>
      )}
    </div>
  );
}
