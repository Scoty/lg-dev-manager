import { posix } from 'node:path';
import ssh2, { type SFTPWrapper } from 'ssh2';
import { canWrite, ensureDir, type MockState } from './state.js';
import { listDir, longname, renamePath, resolveLink, statPath, touch, type Stat } from './fs.js';

// ssh2 is CommonJS: use the default export under native Node ESM.
const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;

interface Handle {
  path: string;
  write: boolean;
  /** Directory handles: entries still to send (null once sent). */
  dir?: string[] | null;
  /** Pending content for files opened for writing; committed on CLOSE. */
  data: Buffer;
  size: number;
}

const fileAttrs = (size: number) => ({ mode: 0o100644, size, uid: 0, gid: 0, atime: 0, mtime: 0 });
const dirAttrs = () => ({ mode: 0o040755, size: 4096, uid: 0, gid: 0, atime: 0, mtime: 0 });
const attrsOf = (st: Stat) => ({ mode: st.mode, size: st.size, uid: st.uid, gid: st.gid, atime: st.mtime, mtime: st.mtime });

/**
 * Enough of an SFTP server for the bridge: open/read/write/close, stat/lstat, opendir/readdir, mkdir, rmdir,
 * remove, rename, readlink.
 * Same permission model as the shell commands (see canWrite).
 */
export function serveSftp(sftp: SFTPWrapper, state: MockState) {
  const handles = new Map<number, Handle>();
  let nextHandle = 1;
  const handleBuf = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const getHandle = (h: Buffer) => (h.length === 4 ? handles.get(h.readUInt32BE(0)) : undefined);

  sftp.on('OPEN', (reqid, filename, flags) => {
    const path = posix.normalize(filename);
    const write = (flags & OPEN_MODE.WRITE) !== 0;
    if (write) {
      if (!canWrite(state, path)) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
      if (!state.dirs.has(posix.dirname(path))) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      const existing = state.files.get(path);
      const keep = existing && !(flags & OPEN_MODE.TRUNC) ? Buffer.from(existing) : Buffer.alloc(0);
      if (!existing && !(flags & OPEN_MODE.CREAT)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      const id = nextHandle++;
      handles.set(id, { path, write: true, data: keep, size: keep.length });
      return sftp.handle(reqid, handleBuf(id));
    }
    const real = resolveLink(state, path) ?? path;
    const f = state.files.get(real);
    if (!f) return sftp.status(reqid, state.dirs.has(real) ? STATUS_CODE.FAILURE : STATUS_CODE.NO_SUCH_FILE);
    const id = nextHandle++;
    handles.set(id, { path: real, write: false, data: f, size: f.length });
    return sftp.handle(reqid, handleBuf(id));
  });

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = getHandle(handle);
    if (!h || !h.write) return sftp.status(reqid, STATUS_CODE.FAILURE);
    const end = offset + data.length;
    if (end > h.data.length) {
      const grown = Buffer.alloc(Math.max(end, h.data.length * 2));
      h.data.copy(grown, 0, 0, h.size);
      h.data = grown;
    }
    data.copy(h.data, offset);
    h.size = Math.max(h.size, end);
    return sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = getHandle(handle);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (offset >= h.size) return sftp.status(reqid, STATUS_CODE.EOF);
    return sftp.data(reqid, h.data.subarray(offset, Math.min(h.size, offset + length)));
  });

  sftp.on('FSTAT', (reqid, handle) => {
    const h = getHandle(handle);
    return h ? sftp.attrs(reqid, fileAttrs(h.size)) : sftp.status(reqid, STATUS_CODE.FAILURE);
  });

  const stat = (follow: boolean) => (reqid: number, p: string) => {
    const st = statPath(state, posix.normalize(p), follow);
    return st ? sftp.attrs(reqid, attrsOf(st)) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
  };
  sftp.on('STAT', stat(true));
  sftp.on('LSTAT', stat(false));

  sftp.on('OPENDIR', (reqid, p) => {
    const path = posix.normalize(p);
    const names = listDir(state, path);
    if (!names) return sftp.status(reqid, state.files.has(path) ? STATUS_CODE.FAILURE : STATUS_CODE.NO_SUCH_FILE);
    const id = nextHandle++;
    handles.set(id, { path, write: false, data: Buffer.alloc(0), size: 0, dir: ['.', '..', ...names] });
    return sftp.handle(reqid, handleBuf(id));
  });

  sftp.on('READDIR', (reqid, handle) => {
    const h = getHandle(handle);
    if (!h || h.dir === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (h.dir === null) return sftp.status(reqid, STATUS_CODE.EOF);
    const entries = h.dir.flatMap((name) => {
      const full = name === '.' ? h.path : name === '..' ? posix.dirname(h.path) : posix.join(h.path, name);
      const st = statPath(state, full, false);
      return st ? [{ filename: name, longname: longname(name, st), attrs: attrsOf(st) }] : [];
    });
    h.dir = null;
    return sftp.name(reqid, entries);
  });

  sftp.on('READLINK', (reqid, p) => {
    const target = state.links.get(posix.normalize(p));
    if (target === undefined) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    return sftp.name(reqid, [{ filename: target, longname: target, attrs: fileAttrs(0) }]);
  });

  sftp.on('RENAME', (reqid, from, to) => {
    const a = posix.normalize(from);
    const b = posix.normalize(to);
    if (!canWrite(state, posix.dirname(a)) || !canWrite(state, posix.dirname(b))) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    const r = renamePath(state, a, b);
    return sftp.status(reqid, r === 'ok' ? STATUS_CODE.OK : r === 'exists' ? STATUS_CODE.FAILURE : STATUS_CODE.NO_SUCH_FILE);
  });

  sftp.on('RMDIR', (reqid, p) => {
    const path = posix.normalize(p);
    const names = listDir(state, path);
    if (!names) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    if (!canWrite(state, posix.dirname(path))) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    if (names.length) return sftp.status(reqid, STATUS_CODE.FAILURE);
    state.dirs.delete(path);
    state.meta.delete(path);
    return sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));

  sftp.on('CLOSE', (reqid, handle) => {
    const h = getHandle(handle);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    handles.delete(handle.readUInt32BE(0));
    if (h.write) {
      state.files.set(h.path, Buffer.from(h.data.subarray(0, h.size)));
      touch(state, h.path);
    }
    return sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('MKDIR', (reqid, p) => {
    const path = posix.normalize(p);
    if (!canWrite(state, path)) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    if (state.dirs.has(path) || state.files.has(path)) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (!state.dirs.has(posix.dirname(path))) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    ensureDir(state, path);
    touch(state, path, true);
    return sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('REMOVE', (reqid, p) => {
    const path = posix.normalize(p);
    if (!state.files.has(path) && !state.links.has(path)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    if (!canWrite(state, path)) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    state.files.delete(path);
    state.links.delete(path);
    state.meta.delete(path);
    return sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('REALPATH', (reqid, p) => {
    const path = posix.normalize(p.startsWith('/') ? p : `/${p}`);
    return sftp.name(reqid, [{ filename: path, longname: path, attrs: dirAttrs() }]);
  });
}
