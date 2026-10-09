import { posix } from 'node:path';
import { ensureDir, type MockState } from './state.js';

/**
 * File metadata for the fake filesystem (owners, modes, times, symlinks), shared by the SFTP server and the shell
 * commands. Paths are absolute and normalised.
 */
export interface Meta {
  mtime: number;
  uid: number;
  gid: number;
  /** Permission bits only (e.g. 0o755). */
  perm: number;
}

export interface Stat {
  type: 'd' | '-' | 'l';
  size: number;
  /** Full st_mode (type bits + permission bits). */
  mode: number;
  mtime: number;
  uid: number;
  gid: number;
}

export const USERS: Record<number, string> = { 0: 'root', 1000: 'prisoner' };
/** A fixed "install time" for files nobody has touched, so listings are stable. */
export const BASE_MTIME = Date.UTC(2026, 0, 15, 9, 30) / 1000;

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const inDev = (p: string) => p === '/media/developer' || p.startsWith('/media/developer/');

function defaultMeta(state: MockState, path: string, dir: boolean): Meta {
  const owner = inDev(path) && state.username !== 'root' ? 1000 : 0;
  const perm = path === '/tmp' ? 0o1777 : dir ? (inDev(path) ? 0o775 : 0o755) : 0o644;
  return { mtime: BASE_MTIME, uid: owner, gid: owner, perm };
}

export function metaOf(state: MockState, path: string): Meta {
  return state.meta.get(path) ?? defaultMeta(state, path, state.dirs.has(path));
}

/** Mark a path as just changed (owned like new files of the logged-in user). */
export function touch(state: MockState, path: string, dir = false) {
  const prev = state.meta.get(path);
  const uid = state.username === 'root' ? 0 : 1000;
  state.meta.set(path, { ...(prev ?? { ...defaultMeta(state, path, dir), uid, gid: uid }), mtime: Math.floor(Date.now() / 1000) });
}

/** Follow a symlink at `path` (up to 8 hops). Null if it doesn't lead anywhere. */
export function resolveLink(state: MockState, path: string): string | null {
  let p = path;
  for (let i = 0; i < 8; i++) {
    const target = state.links.get(p);
    if (target === undefined) return state.dirs.has(p) || state.files.has(p) ? p : null;
    p = posix.resolve(posix.dirname(p), target);
  }
  return null;
}

export function statPath(state: MockState, path: string, follow: boolean): Stat | null {
  const p = posix.normalize(path);
  if (state.links.has(p)) {
    if (!follow) {
      const m = metaOf(state, p);
      return { type: 'l', size: state.links.get(p)!.length, mode: S_IFLNK | 0o777, mtime: m.mtime, uid: m.uid, gid: m.gid };
    }
    const real = resolveLink(state, p);
    return real ? statPath(state, real, true) : null;
  }
  if (state.dirs.has(p)) {
    const m = metaOf(state, p);
    return { type: 'd', size: 4096, mode: S_IFDIR | m.perm, mtime: m.mtime, uid: m.uid, gid: m.gid };
  }
  const f = state.files.get(p);
  if (f) {
    const m = metaOf(state, p);
    return { type: '-', size: f.length, mode: S_IFREG | m.perm, mtime: m.mtime, uid: m.uid, gid: m.gid };
  }
  return null;
}

/** Names directly inside a directory (files, folders and symlinks). Null if it isn't a directory. */
export function listDir(state: MockState, dir: string): string[] | null {
  const d = posix.normalize(dir);
  if (!state.dirs.has(d)) return null;
  const prefix = d === '/' ? '/' : `${d}/`;
  const names = new Set<string>();
  for (const p of [...state.dirs, ...state.files.keys(), ...state.links.keys()]) {
    if (p !== d && p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]!);
  }
  return [...names].sort();
}

const exists = (state: MockState, p: string) => state.dirs.has(p) || state.files.has(p) || state.links.has(p);

/** `rm -r`: a file, link or a whole folder. */
export function removeTree(state: MockState, path: string): boolean {
  const p = posix.normalize(path);
  if (!exists(state, p)) return false;
  const under = (x: string) => x === p || x.startsWith(`${p}/`);
  for (const d of [...state.dirs]) if (under(d)) state.dirs.delete(d);
  for (const f of [...state.files.keys()]) if (under(f)) state.files.delete(f);
  for (const l of [...state.links.keys()]) if (under(l)) state.links.delete(l);
  for (const m of [...state.meta.keys()]) if (under(m)) state.meta.delete(m);
  return true;
}

/** Move a file, link or folder (with its contents). Fails if the target exists, like SFTP v3 rename. */
export function renamePath(state: MockState, from: string, to: string): 'ok' | 'missing' | 'exists' | 'no-parent' {
  const a = posix.normalize(from);
  const b = posix.normalize(to);
  if (!exists(state, a)) return 'missing';
  if (exists(state, b)) return 'exists';
  if (!state.dirs.has(posix.dirname(b))) return 'no-parent';
  const move = (x: string) => (x === a ? b : `${b}${x.slice(a.length)}`);
  const under = (x: string) => x === a || x.startsWith(`${a}/`);
  for (const d of [...state.dirs]) if (under(d)) (state.dirs.delete(d), state.dirs.add(move(d)));
  for (const [f, data] of [...state.files]) if (under(f)) (state.files.delete(f), state.files.set(move(f), data));
  for (const [l, t] of [...state.links]) if (under(l)) (state.links.delete(l), state.links.set(move(l), t));
  for (const [m, v] of [...state.meta]) if (under(m)) (state.meta.delete(m), state.meta.set(move(m), v));
  touch(state, b, state.dirs.has(b));
  return 'ok';
}

export function addLink(state: MockState, path: string, target: string) {
  ensureDir(state, posix.dirname(path));
  state.links.set(path, target);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function modeString(mode: number): string {
  const type = (mode & 0o170000) === S_IFDIR ? 'd' : (mode & 0o170000) === S_IFLNK ? 'l' : '-';
  const bits = (n: number) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
  return `${type}${bits((mode >> 6) & 7)}${bits((mode >> 3) & 7)}${bits(mode & 7)}`;
}

/** `ls -l` style line, like OpenSSH's sftp-server sends as `longname`. */
export function longname(name: string, st: Stat): string {
  const d = new Date(st.mtime * 1000);
  const date = `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const user = (USERS[st.uid] ?? String(st.uid)).padEnd(8);
  const group = (USERS[st.gid] ?? String(st.gid)).padEnd(8);
  return `${modeString(st.mode)}    1 ${user} ${group} ${String(st.size).padStart(8)} ${date} ${name}`;
}
