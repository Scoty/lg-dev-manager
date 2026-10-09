import type { SFTPWrapper } from 'ssh2';
import { AppsErrorCodes, DeviceErrorCodes, type DeviceTarget } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { shellQuote } from './luna.js';
import type { SshRunner } from './pool.js';

/**
 * File transfer to and from the TV. Port of ares-cli-rs `common/connection/src/transfer.rs`:
 * SFTP when the TV offers it, otherwise `cat`, `mkdir -p` and `rm` over exec channels.
 */

const SFTP_CHUNK = 64 * 1024;
const SFTP_IN_FLIGHT = 4;
const STREAM_CHUNK = 64 * 1024;

const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

const transferError = (message: string, detail?: string) => new RpcError(AppsErrorCodes.TransferFailed, message, detail);

function sftpCall<T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
}

/** Make `dir` and every missing parent. As root also chmod it (mkdir_command in transfer.rs). */
export async function mkdirp(pool: SshRunner, device: DeviceTarget, dir: string, mode?: number): Promise<void> {
  const q = shellQuote(dir);
  const res = await pool.exec(device, `mkdir -p ${q}`, { timeoutMs: 20_000 });
  if (res.exitCode !== 0) throw transferError(`Could not create ${dir} on the TV.`, res.stderr.trim());
  if (mode !== undefined && device.username === 'root') {
    await pool.exec(device, `chmod ${mode.toString(8)} ${q}`, { timeoutMs: 20_000 });
  }
}

/** Remove a file. Missing files are not an error. */
export async function rmFile(pool: SshRunner, device: DeviceTarget, path: string): Promise<void> {
  const res = await pool.exec(device, `rm -f ${shellQuote(path)}`, { timeoutMs: 20_000 });
  if (res.exitCode !== 0) throw transferError(`Could not delete ${path} on the TV.`, res.stderr.trim());
}

/** sha256 of a file on the TV, or null if the TV has no `sha256sum` (the check is then skipped, like ares-install). */
export async function sha256sum(pool: SshRunner, device: DeviceTarget, path: string): Promise<string | null> {
  const res = await pool.exec(device, `sha256sum ${shellQuote(path)}`, { timeoutMs: 120_000 });
  if (res.exitCode === 127) return null;
  if (res.exitCode !== 0) throw transferError(`Could not checksum ${path} on the TV.`, res.stderr.trim());
  return res.stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? null;
}

async function putSftp(sftp: SFTPWrapper, path: string, data: Buffer, onProgress?: (sent: number) => void) {
  const handle = await sftpCall<Buffer>((cb) => sftp.open(path, 'w', 0o644, cb));
  try {
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < data.length) {
        const offset = next;
        const len = Math.min(SFTP_CHUNK, data.length - offset);
        next += len;
        await sftpCall<void>((cb) => sftp.write(handle, data, offset, len, offset, (err) => cb(err, undefined)));
        done += len;
        onProgress?.(done);
      }
    };
    await Promise.all(Array.from({ length: SFTP_IN_FLIGHT }, worker));
  } finally {
    await sftpCall<void>((cb) => sftp.close(handle, (err) => cb(err, undefined))).catch(() => {});
  }
}

async function putStream(pool: SshRunner, device: DeviceTarget, path: string, data: Buffer, onProgress?: (sent: number) => void) {
  const ch = await pool.open(device, `cat > ${shellQuote(path)}`);
  const { stream } = ch;
  const errOut: Buffer[] = [];
  stream.stderr.on('data', (c: Buffer) => errOut.push(c));
  stream.on('data', () => {});
  const exit = new Promise<number | null>((resolve) => stream.on('close', (code: number | null) => resolve(typeof code === 'number' ? code : null)));
  try {
    for (let offset = 0; offset < data.length; offset += STREAM_CHUNK) {
      const chunk = data.subarray(offset, offset + STREAM_CHUNK);
      if (!stream.write(chunk)) await new Promise<void>((r) => stream.once('drain', () => r()));
      onProgress?.(Math.min(data.length, offset + chunk.length));
    }
    stream.end();
    const code = await exit;
    if (code !== 0) throw transferError(`Could not write ${path} on the TV.`, Buffer.concat(errOut).toString('utf8').trim());
  } finally {
    ch.close();
  }
}

/** Write `data` to `path` on the TV, reporting bytes sent. */
export async function putFile(
  pool: SshRunner,
  device: DeviceTarget,
  path: string,
  data: Buffer,
  onProgress?: (sent: number) => void,
): Promise<'sftp' | 'stream'> {
  const { sftp, release } = await pool.sftp(device);
  try {
    if (sftp) {
      try {
        await pool.traceOp(device, 'sftp', `sftp put ${path} (${fmtBytes(data.length)})`, () => putSftp(sftp, path, data, onProgress));
        return 'sftp';
      } catch (e) {
        throw transferError(`Could not write ${path} on the TV.`, (e as Error).message);
      }
    }
  } finally {
    release();
  }
  await putStream(pool, device, path, data, onProgress);
  return 'stream';
}

const READ_TIMEOUT_MS = 60_000;
const READ_CHUNK = 32 * 1024;

/**
 * Read up to `maxBytes` of a regular file over SFTP, in chunks. Not ssh2's `readFile`: for files that report size 0
 * (/proc, /sys, and anything linked to /dev/zero or a FIFO) it reads until EOF, past any limit or forever.
 */
async function sftpReadBounded(sftp: SFTPWrapper, path: string, maxBytes: number, tooLarge: () => Error): Promise<Buffer> {
  const handle = await sftpCall<Buffer>((cb) => sftp.open(path, 'r', cb));
  const deadline = Date.now() + READ_TIMEOUT_MS;
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error('timed out');
      const want = Math.min(READ_CHUNK, maxBytes + 1 - total);
      const buf = Buffer.allocUnsafe(want);
      const n = await new Promise<number>((resolve, reject) =>
        sftp.read(handle, buf, 0, want, total, (err, bytesRead) => {
          // EOF arrives as an error with code 1 (SSH_FX_EOF).
          if (err) return (err as Error & { code?: number }).code === 1 ? resolve(0) : reject(err);
          resolve(bytesRead);
        }),
      );
      if (n === 0) break;
      parts.push(buf.subarray(0, n));
      total += n;
      if (total > maxBytes) throw tooLarge();
    }
  } finally {
    sftp.close(handle, () => {});
  }
  return Buffer.concat(parts, total);
}

/** Read a whole (small) regular file from the TV. Fails with file_too_large past `maxBytes`. */
export async function readFile(pool: SshRunner, device: DeviceTarget, path: string, maxBytes: number): Promise<Buffer> {
  const tooLarge = () => new RpcError(AppsErrorCodes.FileTooLarge, `${path} is larger than ${maxBytes} bytes.`);
  const failed = (detail: string) => new RpcError(DeviceErrorCodes.CommandFailed, `Could not read ${path} on the TV.`, detail);
  const { sftp, release } = await pool.sftp(device);
  try {
    if (sftp) {
      const stats = await sftpCall<{ size: number; isFile(): boolean }>((cb) => sftp.stat(path, cb)).catch((e: Error) => {
        throw failed(e.message);
      });
      // Devices, FIFOs and sockets never end (or block): only regular files.
      if (!stats.isFile()) throw failed('Not a regular file.');
      if (stats.size > maxBytes) throw tooLarge();
      return await pool
        .traceOp(device, 'sftp', `sftp get ${path}`, () => sftpReadBounded(sftp, path, maxBytes, tooLarge))
        .catch((e: Error) => {
          throw e instanceof RpcError ? e : failed(e.message);
        });
    }
  } finally {
    release();
  }
  const res = await pool
    .execRaw(device, `cat ${shellQuote(path)}`, { timeoutMs: 30_000, maxOutput: maxBytes + 64 * 1024 })
    .catch((e: RpcError) => {
      throw e.code === DeviceErrorCodes.CommandFailed && /more than/.test(e.message) ? tooLarge() : e;
    });
  if (res.exitCode !== 0) {
    throw new RpcError(DeviceErrorCodes.CommandFailed, `Could not read ${path} on the TV.`, res.stderr.toString('utf8').trim());
  }
  if (res.stdout.length > maxBytes) throw tooLarge();
  return res.stdout;
}
