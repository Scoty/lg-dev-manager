import { connect } from 'node:net';
import { KEY_SERVER_PORT, DEVMODE_SSH_PORT, ROOT_SSH_PORT, WEBOS_SSAP_PORTS } from '@lgdm/protocol';
import { looksLikeWebos } from './webos.js';

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

export interface PortSet {
  ssh22: number;
  ssh9922: number;
  keyServer: number;
  /** LG second-screen ports; any one open means "this is a webOS TV". */
  webos: readonly number[];
}

export const DEFAULT_PORTS: PortSet = {
  ssh22: ROOT_SSH_PORT,
  ssh9922: DEVMODE_SSH_PORT,
  keyServer: KEY_SERVER_PORT,
  webos: WEBOS_SSAP_PORTS,
};

export async function anyOpen(host: string, ports: readonly number[], timeoutMs?: number): Promise<boolean> {
  const res = await Promise.all(ports.map((p) => isPortOpen(host, p, timeoutMs)));
  return res.some(Boolean);
}

/**
 * Port probe used by the add-device wizard (check_connection in dev-manager-desktop), plus "is this a webOS TV":
 * its second-screen port is open and it shows webOS evidence (see webos.ts).
 */
export async function checkConnection(host: string, ports: PortSet = DEFAULT_PORTS, timeoutMs?: number) {
  const [ssh22, ssh9922, keyServer, ssapOpen] = await Promise.all([
    isPortOpen(host, ports.ssh22, timeoutMs),
    isPortOpen(host, ports.ssh9922, timeoutMs),
    isPortOpen(host, ports.keyServer, timeoutMs),
    anyOpen(host, ports.webos, timeoutMs),
  ]);
  // Dropbear alone isn't enough (routers run it too): the second-screen port must be open as well.
  const webos = ssapOpen && (await looksLikeWebos(host, ports, { ssh22, ssh9922 }));
  return { ssh22, ssh9922, keyServer, webos };
}
