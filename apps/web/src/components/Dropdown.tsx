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
 * upwards when there's no room below — for menus inside scrolling containers like tables, which would
 * otherwise clip it.
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
    const h = menu.offsetHeight;
    const w = menu.offsetWidth;
    const bottom = viewportBottom();
    const below = bottom - anchor.bottom - GAP;
    const above = anchor.top - GAP;
    const up = h > below - EDGE && above > below;
    const top = up ? Math.max(EDGE, anchor.top - GAP - h) : anchor.bottom + GAP;
    const left =
      placement === 'down-right'
        ? Math.max(EDGE, anchor.right - w)
        : Math.min(Math.max(EDGE, anchor.left), window.innerWidth - w - EDGE);
    setPos({ top, left });
  }, [placement]);

  useLayoutEffect(() => {
    if (!floating) return;
    if (!open) return setPos(null);
    place();
  }, [floating, open, place]);

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
