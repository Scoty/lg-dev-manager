import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Adminator `.dd-wrap` / `.dd-menu` with click-outside and Escape. `children` receives `close` so menu items
 * can dismiss it.
 */
export function Dropdown({
  trigger,
  children,
  placement = 'down-right',
  className = '',
  menuClassName = '',
  label,
}: {
  trigger: (props: { open: boolean; toggle: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: 'down-right' | 'down-left' | 'up-left';
  className?: string;
  menuClassName?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={`dd-wrap${open ? ' is-open' : ''} ${className}`}>
      {trigger({ open, toggle: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      <div className={`dd-menu dd-menu--${placement} ${menuClassName}`} role="menu" aria-label={label}>
        {open && children(() => setOpen(false))}
      </div>
    </div>
  );
}
