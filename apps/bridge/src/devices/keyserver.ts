import { request } from 'node:http';
import { KEY_SERVER_PORT, DeviceErrorCodes } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';

/** Key server limits, from ares-cli-rs common/connection/src/setup.rs. */
const MAX_KEY_RESPONSE = 65536;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

interface Target {
  host: string;
  port: number;
  path: string;
}

/** Resolve a Location header. Only plain http on the same host and port is followed — the key must come from the device the user named. */
export function resolveRedirect(from: Target, location: string): Target {
  const loc = location.split('#')[0] ?? '';
  if (loc.startsWith('//')) return resolveRedirect(from, `http:${loc}`);
  if (/^http:\/\//i.test(loc)) {
    const url = new URL(loc);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host.toLowerCase() !== from.host.toLowerCase()) {
      throw new RpcError(DeviceErrorCodes.KeyServerUnreachable, `The key server redirected to another host: ${loc}`);
    }
    // …and the same port: a redirect mustn't turn the key fetch into a probe of the TV's (or this computer's) other ports.
    const port = url.port ? Number(url.port) : 80;
    if (port !== from.port) {
      throw new RpcError(DeviceErrorCodes.KeyServerUnreachable, `The key server redirected to another port: ${loc}`);
    }
    return { host: from.host, port, path: `${url.pathname}${url.search}` };
  }
  if (loc.includes('://')) {
    throw new RpcError(DeviceErrorCodes.KeyServerUnreachable, `The key server redirected to a URL that is not plain HTTP: ${loc}`);
  }
  if (loc.startsWith('/')) return { ...from, path: loc };
  const base = (from.path.split('?')[0] ?? '/').replace(/[^/]*$/, '');
  return { ...from, path: `${base}${loc}` };
}

function get(t: Target): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: t.host, port: t.port, path: t.path, method: 'GET', timeout: TIMEOUT_MS, headers: { Accept: '*/*' } },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_KEY_RESPONSE) {
            req.destroy();
            reject(new RpcError(DeviceErrorCodes.KeyNotFound, 'The key server sent an unexpectedly large response.'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) =>
      reject(
        e instanceof RpcError
          ? e
          : new RpcError(
              DeviceErrorCodes.KeyServerUnreachable,
              'Could not reach the key server on the TV. Open the Developer Mode app and turn on "Key Server".',
              (e as NodeJS.ErrnoException).code ?? e.message,
            ),
      ),
    );
    req.end();
  });
}

/** Fetch `webos_rsa` from the Dev Mode key server (port 9991). Follows same-host redirects. */
export async function fetchKey(host: string, port = KEY_SERVER_PORT): Promise<string> {
  let target: Target = { host: host.replace(/^\[|\]$/g, ''), port, path: '/webos_rsa' };
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await get(target);
    if (res.status >= 300 && res.status < 400 && res.location) {
      target = resolveRedirect(target, res.location);
      continue;
    }
    if (res.status !== 200) {
      throw new RpcError(DeviceErrorCodes.KeyNotFound, `The key server answered, but not with a key (HTTP ${res.status}).`);
    }
    return res.body;
  }
  throw new RpcError(DeviceErrorCodes.KeyServerUnreachable, `The key server redirected more than ${MAX_REDIRECTS} times.`);
}
