import type { ClientChannel, TcpConnectionDetails } from 'ssh2';
import { AppsErrorCodes, type DeviceTarget } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import type { SshPool } from './pool.js';

export interface Served {
  /** URL that works from the TV itself, e.g. http://127.0.0.1:41234/app.ipk */
  url: string;
  /** Bytes the TV has read so far. */
  readonly sent: number;
  close(): Promise<void>;
}

const HEADER_LIMIT = 16 * 1024;

/**
 * Serve one file to the TV over an SSH remote port forward on the TV's loopback — the bridge itself stays
 * bound to 127.0.0.1 on this computer. Port of remote_files/serve.rs (`listen_forward` + a tiny HTTP responder)
 * in dev-manager-desktop. Only answers GET/HEAD for the file's path.
 */
export async function serveToDevice(
  pool: SshPool,
  device: DeviceTarget,
  name: string,
  data: Buffer,
  onProgress?: (sent: number) => void,
): Promise<Served> {
  const { client, release } = await pool.acquire(device);
  const path = `/${encodeURIComponent(name.replace(/[^\w.-]+/g, '_') || 'file')}`;
  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) =>
      client.forwardIn('127.0.0.1', 0, (err, p) => (err ? reject(err) : resolve(p))),
    );
  } catch (e) {
    release();
    throw new RpcError(AppsErrorCodes.TransferFailed, 'The TV did not allow a tunnel back to the bridge.', (e as Error).message);
  }

  let sent = 0;
  const open = new Set<ClientChannel>();

  const respond = (ch: ClientChannel, head: string) => {
    const [requestLine = ''] = head.split('\r\n');
    const [method = '', target = ''] = requestLine.split(' ');
    const ok = (method === 'GET' || method === 'HEAD') && target.split('?')[0] === path;
    if (!ok) {
      ch.end('HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    ch.write(
      `HTTP/1.0 200 OK\r\nContent-Type: application/vnd.debian.binary-package\r\nContent-Length: ${data.length}\r\nConnection: close\r\n\r\n`,
    );
    if (method === 'HEAD') return void ch.end();
    let offset = 0;
    const pump = () => {
      while (offset < data.length) {
        const chunk = data.subarray(offset, offset + 64 * 1024);
        offset += chunk.length;
        sent = Math.max(sent, offset);
        onProgress?.(sent);
        if (!ch.write(chunk)) return void ch.once('drain', pump);
      }
      ch.end();
    };
    pump();
  };

  const onConnection = (details: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void) => {
    if (details.destPort !== port) return; // another forward on this connection
    if (open.size > 8) return reject();
    const ch = accept();
    open.add(ch);
    ch.on('close', () => open.delete(ch));
    ch.on('error', () => {});
    let head = '';
    const onData = (c: Buffer) => {
      head += c.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end >= 0) {
        ch.off('data', onData);
        respond(ch, head.slice(0, end));
      } else if (head.length > HEADER_LIMIT) {
        ch.off('data', onData);
        ch.end('HTTP/1.0 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n');
      }
    };
    ch.on('data', onData);
  };
  client.on('tcp connection', onConnection);

  return {
    url: `http://127.0.0.1:${port}${path}`,
    get sent() {
      return sent;
    },
    close: async () => {
      client.off('tcp connection', onConnection);
      for (const ch of open) ch.close();
      await new Promise<void>((r) => client.unforwardIn('127.0.0.1', port, () => r()));
      release();
    },
  };
}
