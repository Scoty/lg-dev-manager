import type { SFTPWrapper } from 'ssh2';
import { AppsErrorCodes, DeviceErrorCodes, type DeviceTarget } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { shellQuote } from './luna.js';
import type { SshPool } from './pool.js';

/**
 * File transfer to and from the TV. Port of ares-cli-rs `common/connection/src/transfer.rs`:
 * SFTP when the TV offers it, otherwise `cat`, `mkdir -p` and `rm` over exec channels.
 */

const SFTP_CHUNK = 64 * 1024;
const SFTP_IN_FLIGHT = 4;
const STREAM_CHUNK = 64 * 1024;

const transferError = (message: string, detail?: string) => new RpcError(AppsErrorCodes.TransferFailed, message, detail);

function sftpCall<T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
}

/** Make `dir` and every missing parent. As root also chmod it (mkdir_command in transfer.rs). */
export async function mkdirp(pool: SshPool, device: DeviceTarget, dir: string, mode?: number): Promise<void> {
  const q = shellQuote(dir);
  const res = await pool.exec(device, `mkdir -p ${q}`, { timeoutMs: 20_000 });
  if (res.exitCode !== 0) throw transferError(`Could not create ${dir} on the TV.`, res.stderr.trim());
  if (mode !== undefined && device.username === 'root') {
    await pool.exec(device, `chmod ${mode.toString(8)} ${q}`, { timeoutMs: 20_000 });
  }
}

/** Remove a file. Missing files are not an error. */
export async function rmFile(pool: SshPool, device: DeviceTarget, path: string): Promise<void> {
  const res = await pool.exec(device, `rm -f ${shellQuote(path)}`, { timeoutMs: 20_000 });
  if (res.exitCode !== 0) throw transferError(`Could not delete ${path} on the TV.`, res.stderr.trim());
}

/** sha256 of a file on the TV, or null if the TV has no `sha256sum` (the check is then skipped, like ares-install). */
export async function sha256sum(pool: SshPool, device: DeviceTarget, path: string): Promise<string | null> {
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

async function putStream(pool: SshPool, device: DeviceTarget, path: string, data: Buffer, onProgress?: (sent: number) => void) {
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
  pool: SshPool,
  device: DeviceTarget,
  path: string,
  data: Buffer,
  onProgress?: (sent: number) => void,
): Promise<'sftp' | 'stream'> {
  const { sftp, release } = await pool.sftp(device);
  try {
    if (sftp) {
      try {
        await putSftp(sftp, path, data, onProgress);
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

/** Read a whole (small) file from the TV. Fails with file_too_large past `maxBytes`. */
export async function readFile(pool: SshPool, device: DeviceTarget, path: string, maxBytes: number): Promise<Buffer> {
  const tooLarge = () => new RpcError(AppsErrorCodes.FileTooLarge, `${path} is larger than ${maxBytes} bytes.`);
  const { sftp, release } = await pool.sftp(device);
  try {
    if (sftp) {
      const stats = await sftpCall<{ size: number }>((cb) => sftp.stat(path, cb)).catch((e: Error) => {
        throw new RpcError(DeviceErrorCodes.CommandFailed, `Could not read ${path} on the TV.`, e.message);
      });
      if (stats.size > maxBytes) throw tooLarge();
      return await sftpCall<Buffer>((cb) => sftp.readFile(path, cb)).catch((e: Error) => {
        throw new RpcError(DeviceErrorCodes.CommandFailed, `Could not read ${path} on the TV.`, e.message);
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
