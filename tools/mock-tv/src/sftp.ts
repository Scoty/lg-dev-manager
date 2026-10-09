import { posix } from 'node:path';
import ssh2, { type SFTPWrapper } from 'ssh2';
import { canWrite, ensureDir, type MockState } from './state.js';

// ssh2 is CommonJS: use the default export under native Node ESM.
const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;

interface Handle {
  path: string;
  write: boolean;
  /** Pending content for files opened for writing; committed on CLOSE. */
  data: Buffer;
  size: number;
}

const fileAttrs = (size: number) => ({ mode: 0o100644, size, uid: 0, gid: 0, atime: 0, mtime: 0 });
const dirAttrs = () => ({ mode: 0o040755, size: 4096, uid: 0, gid: 0, atime: 0, mtime: 0 });

/**
 * Enough of an SFTP server for the bridge's file transfers: open/read/write/close, stat, mkdir, remove.
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
    const f = state.files.get(path);
    if (!f) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    const id = nextHandle++;
    handles.set(id, { path, write: false, data: f, size: f.length });
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

  const stat = (reqid: number, p: string) => {
    const path = posix.normalize(p);
    const f = state.files.get(path);
    if (f) return sftp.attrs(reqid, fileAttrs(f.length));
    if (state.dirs.has(path)) return sftp.attrs(reqid, dirAttrs());
    return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
  };
  sftp.on('STAT', stat);
  sftp.on('LSTAT', stat);

  sftp.on('CLOSE', (reqid, handle) => {
    const h = getHandle(handle);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    handles.delete(handle.readUInt32BE(0));
    if (h.write) state.files.set(h.path, Buffer.from(h.data.subarray(0, h.size)));
    return sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('MKDIR', (reqid, p) => {
    const path = posix.normalize(p);
    if (!canWrite(state, path)) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    if (state.dirs.has(path) || state.files.has(path)) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (!state.dirs.has(posix.dirname(path))) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    ensureDir(state, path);
    return sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('REMOVE', (reqid, p) => {
    const path = posix.normalize(p);
    if (!state.files.has(path)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    if (!canWrite(state, path)) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    state.files.delete(path);
    return sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('REALPATH', (reqid, p) => {
    const path = posix.normalize(p.startsWith('/') ? p : `/${p}`);
    return sftp.name(reqid, [{ filename: path, longname: path, attrs: dirAttrs() }]);
  });
}
