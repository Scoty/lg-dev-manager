import type { FileItem } from '@lgdm/protocol';

/** POSIX path helpers for paths on the TV (always absolute, no trailing slash except "/"). */
export const joinPath = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

export const parentOf = (path: string) => {
  if (path === '/') return null;
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
};

/** Tidy a typed path: absolute, no `.`/`..`/empty segments, no trailing slash. Null if it escapes the root. */
export function normalizePath(input: string, cwd = '/'): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const parts = (raw.startsWith('/') ? raw : `${cwd}/${raw}`).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(p);
  }
  return `/${out.join('/')}`;
}

/** Breadcrumb segments: [{ name: '/', path: '/' }, { name: 'media', path: '/media' }, …]. */
export function crumbsOf(path: string): { name: string; path: string }[] {
  const out = [{ name: '/', path: '/' }];
  let acc = '';
  for (const seg of path.split('/').filter(Boolean)) {
    acc += `/${seg}`;
    out.push({ name: seg, path: acc });
  }
  return out;
}

/** Folders, and symlinks that lead to folders, can be opened. */
export const isDirLike = (f: FileItem) => f.type === 'd' || (f.type === 'l' && f.link?.type === 'd');
/** Regular files (or links to them) can be previewed and downloaded. */
export const isFileLike = (f: FileItem) => f.type === '-' || (f.type === 'l' && f.link?.type === '-');

export const fmtBytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MB`
      : n >= 1024
        ? `${(n / 1024).toFixed(n >= 10 * 1024 ? 0 : 1)} KB`
        : `${n} B`;

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const fmtTime = (seconds: number) => (seconds > 0 ? dateFmt.format(new Date(seconds * 1000)) : '—');

export type SortKey = 'name' | 'size' | 'mtime';

/** Folders first, then the chosen key (compareName / compareSize / compareMtime in files.component.ts). */
export function sortItems(items: FileItem[], key: SortKey, dir: 'asc' | 'desc'): FileItem[] {
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a: FileItem, b: FileItem) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  return [...items].sort((a, b) => {
    const folders = Number(isDirLike(b)) - Number(isDirLike(a));
    if (folders) return folders;
    if (key === 'size') return sign * ((isFileLike(a) ? a.size : 0) - (isFileLike(b) ? b.size : 0)) || byName(a, b);
    if (key === 'mtime') return sign * (a.mtime - b.mtime) || byName(a, b);
    return sign * byName(a, b);
  });
}

/** Text files worth previewing inline, by name. Everything else is checked by content. */
const TEXT_EXT = /\.(txt|log|json|conf|cfg|ini|sh|js|mjs|ts|css|html?|xml|md|csv|yml|yaml|properties|service|desktop|prefs|list|py|lua|svg)$/i;
/**
 * Raster images previewed inline (as blob: URLs). Not SVG: it is a document that can run script, and a blob: URL
 * has this site's origin, so "open image in new tab" would run the TV's SVG as this site. SVGs show as text.
 * A Map, so names like "x.constructor" don't hit Object.prototype.
 */
const IMAGE_EXT = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
]);

export const imageType = (name: string): string | undefined => (name.includes('.') ? IMAGE_EXT.get(name.split('.').pop()!.toLowerCase()) : undefined);
export const looksLikeText = (name: string) => TEXT_EXT.test(name) || !name.includes('.');

/** True when a buffer is plausibly UTF-8 text (no NULs, few control bytes). */
export function isProbablyText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i]!;
    if (c === 0) return false;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 27) odd++;
  }
  return odd <= n / 50;
}
