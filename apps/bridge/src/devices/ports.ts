import { connect } from 'node:net';
import { KEY_SERVER_PORT, DEVMODE_SSH_PORT, ROOT_SSH_PORT } from '@lgdm/protocol';

/** True if a TCP connection to host:port succeeds within the timeout. */
export function isPortOpen(host: string, port: number, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: host.replace(/^\[|\]$/g, ''), port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Port probe used by the add-device wizard (check_connection in dev-manager-desktop). */
export async function checkConnection(
  host: string,
  ports = { ssh22: ROOT_SSH_PORT, ssh9922: DEVMODE_SSH_PORT, keyServer: KEY_SERVER_PORT },
  timeoutMs?: number,
) {
  const [ssh22, ssh9922, keyServer] = await Promise.all([
    isPortOpen(host, ports.ssh22, timeoutMs),
    isPortOpen(host, ports.ssh9922, timeoutMs),
    isPortOpen(host, ports.keyServer, timeoutMs),
  ]);
  return { ssh22, ssh9922, keyServer };
}
