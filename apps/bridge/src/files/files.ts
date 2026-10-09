import { posix } from 'node:path';
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import { DeviceErrorCodes, FilesErrorCodes, READ_BLOCK, type DeviceTarget, type FileItem } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { shellQuote } from '../ssh/luna.js';
import type { SshRunner } from '../ssh/pool.js';
import { putFile } from '../ssh/transfer.js';

/**
 * The Files page's operations. Port of the original's file plugin (src-tauri/src/plugins/file.rs) and
 * FileSessionImpl (src/app/core/services/file.session.ts): listing needs SFTP like the original; reads fall back
 * to `dd`, writes to `cat` (transfer.ts); deletes are `rm -r` over exec.
 */

const S_IFMT = 0o170000;
const TYPES: Record<number, FileItem['type']> = {
  0o040000: 'd',
  0o100000: '-',
  0o120000: 'l',
  0o020000: 'c',
  0o060000: 'b',
  0o010000: 'p',
  0o140000: 's',
};
/** Normalised absolute path without a trailing slash ("/" stays "/"). */
const clean = (p: string) => posix.normalize(p).replace(/(.)\/+$/, '$1');
const typeOf = (mode: number): FileItem['type'] => TYPES[mode & S_IFMT] ?? '?';
const bits = (n: number) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
export const modeString = (mode: number) => `${bits((mode >> 6) & 7)}${bits((mode >> 3) & 7)}${bits(mode & 7)}`;

/** Who we are on the TV, for working out access (DeviceConnectionUserInfo in the original). */
interface UserInfo {
  uid: number;
  gids: number[];
}

/** PermInfo::from in remote_files/sftp.rs: owner bits, then group bits, then other bits. Root may do anything. */
function accessOf(attrs: Stats, user: UserInfo | null): FileItem['access'] {
  if (!user) return undefined;
  if (user.uid === 0) return { read: true, write: true, execute: (attrs.mode & 0o111) !== 0 || typeOf(attrs.mode) === 'd' };
  const m = attrs.mode;
  const shift = user.uid === attrs.uid ? 6 : user.gids.includes(attrs.gid) ? 3 : 0;
  return { read: ((m >> shift) & 4) !== 0, write: ((m >> shift) & 2) !== 0, execute: ((m >> shift) & 1) !== 0 };
}

function sftpCall<T>(fn: (cb: (err: (Error & { code?: number }) | null | undefined, v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
}

/** SFTP status codes → the errors the UI explains (FileError.NotFound / Denied in file.session.ts). */
function mapSftpError(e: unknown, path: string, action: string): RpcError {
  if (e instanceof RpcError) return e;
  const err = e as Error & { code?: number };
  if (err.code === 2) return new RpcError(FilesErrorCodes.NotFound, `${path} doesn’t exist.`, err.message);
  if (err.code === 3) return new RpcError(FilesErrorCodes.Denied, `You don’t have permission to ${action} ${path}.`, err.message);
  return new RpcError(FilesErrorCodes.Failed, `Couldn’t ${action} ${path}.`, err.message);
}

async function withSftp<T>(pool: SshRunner, device: DeviceTarget, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const { sftp, release } = await pool.sftp(device);
  try {
    if (!sftp) {
      throw new RpcError(FilesErrorCodes.NoSftp, 'This TV doesn’t offer SFTP, which the file browser needs.', 'The SSH server refused the sftp subsystem.');
    }
    return await fn(sftp);
  } finally {
    release();
  }
}

/** The login's home folder (FileSessionImpl.home: `echo -n $HOME`, default /media/developer). */
export async function homeDir(pool: SshRunner, device: DeviceTarget): Promise<string> {
  const res = await pool.exec(device, 'echo -n $HOME', { timeoutMs: 20_000 });
  const home = res.exitCode === 0 ? res.stdout.trim().replace(/\/+$/, '') : '';
  return home.startsWith('/') ? home : '/media/developer';
}

/** uid/gids per login, kept in memory for a while (one `id` per folder would fill the console). */
const users = new Map<string, { at: number; info: UserInfo | null }>();
const USER_TTL = 10 * 60_000;

async function userInfo(pool: SshRunner, device: DeviceTarget): Promise<UserInfo | null> {
  const key = `${device.username}@${device.host}:${device.port}`;
  const hit = users.get(key);
  if (hit && Date.now() - hit.at < USER_TTL) return hit.info;
  const res = await pool.exec(device, 'id -u; id -G', { timeoutMs: 20_000 }).catch(() => null);
  let info: UserInfo | null = null;
  if (res && res.exitCode === 0) {
    const [uidLine, groupsLine] = res.stdout.trim().split('\n');
    const uid = Number(uidLine);
    if (Number.isInteger(uid)) info = { uid, gids: (groupsLine ?? '').trim().split(/\s+/).map(Number).filter(Number.isInteger) };
  }
  if (info) users.set(key, { at: Date.now(), info });
  return info;
}

/** Owner and group names from an `ls -l` style longname ("-rw-r--r--  1 root  root  …"). */
function namesFrom(longname: string | undefined): { user?: string; group?: string } {
  const parts = longname?.trim().split(/\s+/) ?? [];
  return parts.length >= 8 ? { user: parts[2], group: parts[3] } : {};
}

function itemOf(name: string, attrs: Stats, longname: string | undefined, user: UserInfo | null): FileItem {
  const { user: owner, group } = namesFrom(longname);
  const item: FileItem = {
    name,
    type: typeOf(attrs.mode),
    mode: modeString(attrs.mode),
    size: attrs.size,
    mtime: typeof attrs.mtime === 'number' ? attrs.mtime : 0,
  };
  if (owner) item.user = owner;
  else if (attrs.uid !== undefined) item.user = String(attrs.uid);
  if (group) item.group = group;
  else if (attrs.gid !== undefined) item.group = String(attrs.gid);
  const access = accessOf(attrs, user);
  if (access) item.access = access;
  return item;
}

/** Run `fn` over `items` with at most `n` at once. */
async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** A directory listing (file::ls), with symlink targets resolved so linked folders can be opened. */
export async function listDir(pool: SshRunner, device: DeviceTarget, dir: string): Promise<{ path: string; items: FileItem[] }> {
  const path = clean(dir);
  const userP = userInfo(pool, device);
  return withSftp(pool, device, async (sftp) => {
    const entries = await pool
      .traceOp(device, 'sftp', `sftp ls ${path}`, () => sftpCall<FileEntryWithStats[]>((cb) => sftp.readdir(path, cb)))
      .catch(async (e: Error & { code?: number }) => {
        // readdir on a file fails with a generic error; say what it is.
        if (e.code !== 2 && e.code !== 3) {
          const st = await sftpCall<Stats>((cb) => sftp.stat(path, cb)).catch(() => null);
          if (st && typeOf(st.mode) !== 'd') throw new RpcError(FilesErrorCodes.NotADirectory, `${path} is a file, not a folder.`);
        }
        throw mapSftpError(e, path, 'open');
      });
    const user = await userP;
    const visible = entries.filter((e) => e.filename !== '.' && e.filename !== '..');
    const items = await mapLimit(visible, 8, async (e) => {
      const item = itemOf(e.filename, e.attrs, e.longname, user);
      if (item.type === 'l') {
        const full = posix.join(path, e.filename);
        const [target, real] = await Promise.all([
          sftpCall<string>((cb) => sftp.readlink(full, cb)).catch(() => undefined),
          sftpCall<Stats>((cb) => sftp.stat(full, cb)).catch(() => null),
        ]);
        item.link = { ...(target !== undefined ? { target } : {}), ...(real ? { type: typeOf(real.mode) } : { broken: true }) };
      }
      return item;
    });
    return { path, items };
  });
}

/** One file's details, following symlinks. */
export async function statFile(pool: SshRunner, device: DeviceTarget, path: string): Promise<FileItem> {
  const p = clean(path);
  return withSftp(pool, device, async (sftp) => {
    const attrs = await sftpCall<Stats>((cb) => sftp.stat(p, cb)).catch((e) => {
      throw mapSftpError(e, p, 'read');
    });
    return itemOf(posix.basename(p) || '/', attrs, undefined, null);
  });
}

/** Part of a file: SFTP, or `dd` in 64 KiB blocks on TVs without SFTP. */
export async function readChunk(pool: SshRunner, device: DeviceTarget, path: string, offset: number, length: number): Promise<{ data: Buffer; eof: boolean }> {
  const p = clean(path);
  const { sftp, release } = await pool.sftp(device);
  try {
    if (sftp) {
      const handle = await sftpCall<Buffer>((cb) => sftp.open(p, 'r', cb)).catch((e) => {
        throw mapSftpError(e, p, 'read');
      });
      try {
        const buf = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
          const n = await sftpCall<number>((cb) =>
            sftp.read(handle, buf, got, Math.min(64 * 1024, length - got), offset + got, (err, bytes) => cb(err, bytes)),
          ).catch((e: Error & { code?: number }) => {
            if (e.code === 1) return 0; // EOF
            throw mapSftpError(e, p, 'read');
          });
          if (n === 0) break;
          got += n;
        }
        return { data: buf.subarray(0, got), eof: got < length };
      } finally {
        await sftpCall<void>((cb) => sftp.close(handle, (err) => cb(err, undefined))).catch(() => {});
      }
    }
  } finally {
    release();
  }
  if (offset % READ_BLOCK !== 0) throw new RpcError('bad_request', `Offsets must be multiples of ${READ_BLOCK} bytes.`);
  const blocks = Math.ceil(length / READ_BLOCK);
  const res = await pool.execRaw(device, `dd if=${shellQuote(p)} bs=${READ_BLOCK} skip=${offset / READ_BLOCK} count=${blocks}`, {
    timeoutMs: 120_000,
    maxOutput: blocks * READ_BLOCK + 4096,
  });
  if (res.exitCode !== 0) {
    const msg = res.stderr.toString('utf8').trim();
    if (/no such file/i.test(msg)) throw new RpcError(FilesErrorCodes.NotFound, `${p} doesn’t exist.`, msg);
    if (/permission denied/i.test(msg)) throw new RpcError(FilesErrorCodes.Denied, `You don’t have permission to read ${p}.`, msg);
    throw new RpcError(FilesErrorCodes.Failed, `Couldn’t read ${p}.`, msg);
  }
  const data = res.stdout.subarray(0, length);
  return { data, eof: data.length < length };
}

async function exists(pool: SshRunner, device: DeviceTarget, path: string): Promise<boolean> {
  return withSftp(pool, device, (sftp) =>
    sftpCall<Stats>((cb) => sftp.lstat(path, cb)).then(
      () => true,
      (e: Error & { code?: number }) => {
        if (e.code === 2) return false;
        throw mapSftpError(e, path, 'check');
      },
    ),
  );
}

/** Upload (file::put): refuses to replace an existing file unless asked to. */
export async function writeFile(
  pool: SshRunner,
  device: DeviceTarget,
  path: string,
  data: Buffer,
  overwrite: boolean,
  onProgress?: (sent: number) => void,
): Promise<{ size: number }> {
  const p = clean(path);
  if (!overwrite && (await exists(pool, device, p))) {
    throw new RpcError(FilesErrorCodes.Exists, `${posix.basename(p)} already exists in ${posix.dirname(p)}.`);
  }
  await putFile(pool, device, p, data, onProgress).catch((e: RpcError) => {
    throw new RpcError(/denied/i.test(`${e.message} ${e.detail ?? ''}`) ? FilesErrorCodes.Denied : FilesErrorCodes.Failed, e.message, e.detail);
  });
  return { size: data.length };
}

export async function makeDir(pool: SshRunner, device: DeviceTarget, parent: string, name: string): Promise<{ path: string }> {
  const p = posix.join(parent, name);
  return withSftp(pool, device, async (sftp) => {
    const st = await sftpCall<Stats>((cb) => sftp.lstat(p, cb)).catch(() => null);
    if (st) throw new RpcError(FilesErrorCodes.Exists, `${name} already exists in ${parent}.`);
    await pool.traceOp(device, 'sftp', `sftp mkdir ${p}`, () => sftpCall<void>((cb) => sftp.mkdir(p, (err) => cb(err, undefined)))).catch((e) => {
      throw mapSftpError(e, p, 'create');
    });
    return { path: p };
  });
}

export async function renameFile(pool: SshRunner, device: DeviceTarget, parent: string, from: string, to: string): Promise<{ path: string }> {
  const a = posix.join(parent, from);
  const b = posix.join(parent, to);
  return withSftp(pool, device, async (sftp) => {
    const st = await sftpCall<Stats>((cb) => sftp.lstat(b, cb)).catch(() => null);
    if (st) throw new RpcError(FilesErrorCodes.Exists, `${to} already exists in ${parent}.`);
    await pool.traceOp(device, 'sftp', `sftp rename ${a} → ${b}`, () => sftpCall<void>((cb) => sftp.rename(a, b, (err) => cb(err, undefined)))).catch((e) => {
      throw mapSftpError(e, a, 'rename');
    });
    return { path: b };
  });
}

/** `rm -r` (FileSessionImpl.rm with recursive). Refuses the root folder outright. */
export async function removePath(pool: SshRunner, device: DeviceTarget, path: string): Promise<void> {
  const p = clean(path);
  if (!p || p === '/') throw new RpcError('bad_request', 'Refusing to delete the root folder.');
  const res = await pool.exec(device, `rm -r -- ${shellQuote(p)}`, { timeoutMs: 120_000 });
  if (res.exitCode !== 0) {
    const msg = res.stderr.trim();
    if (/permission denied|read-only/i.test(msg)) throw new RpcError(FilesErrorCodes.Denied, `You don’t have permission to delete ${p}.`, msg);
    if (/no such file/i.test(msg)) throw new RpcError(FilesErrorCodes.NotFound, `${p} doesn’t exist.`, msg);
    throw new RpcError(DeviceErrorCodes.CommandFailed, `Couldn’t delete ${p}.`, msg);
  }
}
