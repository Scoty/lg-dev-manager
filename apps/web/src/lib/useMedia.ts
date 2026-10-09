import { useEffect, useState } from 'react';

/** Whether a CSS media query matches, kept up to date. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** The sidebar is an icon rail (styles/adminator/_responsive.scss: 721–1100px). */
export const RAIL_QUERY = '(min-width: 721px) and (max-width: 1100px)';
