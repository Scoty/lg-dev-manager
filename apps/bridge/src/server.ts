import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BridgeConfig } from './config.js';
import { dispatch } from './rpc/dispatch.js';
import type { Session } from './rpc/handlers.js';
import { serveStatic } from './http/static.js';
import { BRIDGE_VERSION } from './version.js';
import { SshPool } from './ssh/pool.js';
import { UploadStore } from './rpc/uploads.js';
import { RepoClient } from './repo/repo.js';
import { RepoRegistry } from './repo/registry.js';
import { LitefinClient } from './litefin/litefin.js';
import { ShellSessions } from './shell/shells.js';
import { forwardedProblem, isLanClient, limiterKey, PairingLimiter, viaCloudflare } from './lan.js';
import { CfAccess, type AccessIdentity } from './cfaccess.js';

/**
 * A connection let in by Cloudflare Access lasts at most this long (or until the Access token expires): revoking
 * someone in Access stops new requests at Cloudflare's edge, and the page reconnects through it, checked again.
 */
export const ACCESS_CONNECTION_MS = 60 * 60_000;
import { takePairRedirect } from './pairing.js';
import { BridgeStore } from './store/store.js';
import { STORE_CHANGED_EVENT } from '@lgdm/protocol';
import { ErrorCodes } from '@lgdm/protocol';

export const RPC_PATH = '/rpc';

/** Unanswered pings before a connection counts as gone (its shells, streams and uploads are then closed). */
const HEARTBEAT_MS = 30_000;
/** Output waits while this much is queued for a slow browser tab (Session.waitForRoom). */
const SEND_HIGH = 4 * 1024 * 1024;
const SEND_LOW = 1024 * 1024;

/**
 * Requests must name this bridge as 127.0.0.1 or localhost — or, in LAN mode, by one of its public URLs: a page whose
 * DNS name was re-pointed here (DNS rebinding) can't.
 */
const hostAllowed = (host: string | undefined, port: number, publicHosts: string[]) =>
  host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}` || (!!host && publicHosts.includes(host.toLowerCase()));

/** console.warn, at most once per 10 s per kind of message, counting the ones it held back. */
function throttledWarn() {
  const last = new Map<string, { at: number; held: number }>();
  return (message: string) => {
    const key = message.replace(/[\d.:a-f]{7,}/gi, '#').slice(0, 80);
    const now = Date.now();
    const e = last.get(key);
    if (e && now - e.at < 10_000) {
      e.held++;
      return;
    }
    const safe = message.replace(/[^\x20-\x7e]/g, '?').slice(0, 300);
    console.warn(`[bridge] ${safe}${e?.held ? ` (and ${e.held} more like it)` : ''}`);
    last.set(key, { at: now, held: 0 });
    if (last.size > 100) last.delete(last.keys().next().value!);
  };
}

export function startServer(
  config: BridgeConfig,
  pool = new SshPool(),
  repo = new RepoClient(config.repoUrl),
  litefin = new LitefinClient(config.litefinUrl),
  /** Tests: a CfAccess with its own key source. */
  access = config.lan?.cfAccess ? new CfAccess(config.lan.cfAccess) : undefined,
): Promise<Server> {
  const repos = new RepoRegistry(repo);
  const lan = config.lan;
  // Storage (--store): every paired browser hears about each change, so they all show the same TVs.
  const store = config.storeDir ? new BridgeStore(config.storeDir) : undefined;
  // A stored TV's login is only sent to a TV with the host key it had (ssh/pool.ts).
  if (store) pool.hostKeys = store;
  const sessions = new Set<Session>();
  if (store) store.onChange = (change) => sessions.forEach((s) => s.authed && s.emit(STORE_CHANGED_EVENT, change));
  const publicHosts = (lan?.publicUrls ?? []).map((u) => new URL(u).host.toLowerCase());
  const limiter = new PairingLimiter();
  /**
   * Why this request may not use the bridge at all, or null. Every mode: it must not come through a proxy or tunnel
   * from the internet. LAN mode: the client itself must be on the local network (or this computer).
   */
  const clientProblem = (req: import('node:http').IncomingMessage): string | null => {
    const forwarded = forwardedProblem(req.headers, lan?.extraNetworks);
    if (forwarded) {
      const hint = viaCloudflare(req.headers) ? ' To reach it from outside, protect it with Cloudflare Access and set LGDM_CF_ACCESS_* (see the README).' : '';
      return `${forwarded}. The bridge controls your TVs: never make it reachable from the internet.${hint}`;
    }
    if (lan && !isLanClient(req.socket.remoteAddress, lan.extraNetworks)) {
      return `${req.socket.remoteAddress ?? 'the client'} isn't on your local network. If it is (a global IPv6 address, say), add its network to LGDM_ALLOWED_NETWORKS.`;
    }
    return null;
  };
  /**
   * clientProblem, plus Cloudflare Access (cfaccess.ts) when it's set up: a request through Cloudflare then needs a valid
   * Access token instead of being refused — still only from a tunnel client on the local network or this computer.
   */
  // The https addresses in LAN mode with Cloudflare Access are the Cloudflare hostnames: a request for one needs an
  // Access token even without Cloudflare's headers (a Worker that rebuilds requests, a header Cloudflare drops).
  const accessOrigins = access ? (lan?.publicUrls ?? []).filter((u) => u.startsWith('https://')) : [];
  const accessHosts = accessOrigins.map((u) => new URL(u).host.toLowerCase());
  if (access) void access.warmUp();
  const checkClient = async (req: import('node:http').IncomingMessage): Promise<{ problem: string | null; access?: AccessIdentity }> => {
    const needsAccess = !!access && !!lan && (!!viaCloudflare(req.headers) || accessHosts.includes((req.headers.host ?? '').toLowerCase()));
    if (!access || !lan || !needsAccess) return { problem: clientProblem(req) };
    if (!isLanClient(req.socket.remoteAddress, lan.extraNetworks)) {
      return { problem: `${req.socket.remoteAddress ?? 'the client'} isn't on your local network (Cloudflare Tunnel's cloudflared must run there).` };
    }
    const header = req.headers['cf-access-jwt-assertion'];
    try {
      return { problem: null, access: await access.verify(Array.isArray(header) ? header[0] : header) };
    } catch (e) {
      return { problem: `it came through Cloudflare without a valid Access token: ${(e as Error).message}` };
    }
  };
  /** Who Cloudflare Access let in, per upgrade request, for the WebSocket that follows. */
  const accessOf = new WeakMap<import('node:http').IncomingMessage, AccessIdentity>();
  const refusedLog = throttledWarn();

  const http = createServer((req, res) => {
    // A failure answers this request, never ends the process.
    checkClient(req)
      .then(({ problem }) => respond(req, res, problem))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  const respond = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, problem: string | null) => {
    if (problem) {
      refusedLog(`refused a request: ${problem}`);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Refused: the LG Dev Manager bridge only answers on your local network.');
      return;
    }
    if (!hostAllowed(req.headers.host, listeningPort(), publicHosts)) {
      res.writeHead(421, { 'content-type': 'text/plain' }).end(lan ? `Wrong host. Open the bridge at ${lan.publicUrls.join(' or ')}.` : 'Wrong host.');
      return;
    }
    const redirect = req.method === 'GET' ? takePairRedirect((req.url ?? '').split('?')[0]!) : null;
    if (redirect) {
      res.writeHead(302, { location: redirect, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end();
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, version: BRIDGE_VERSION }));
      return;
    }
    if (config.webRoot) return serveStatic(config.webRoot, req, res);
    res.writeHead(200, { 'content-type': 'text/plain' }).end(
      `LG Dev Manager bridge ${BRIDGE_VERSION} is running. Open the web app and pair with this bridge.`,
    );
  };

  // The port actually bound (config.port may be 0 in tests).
  const listeningPort = () => (http.address() as AddressInfo | null)?.port ?? config.port;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
  });

  // Any web page can knock; say so in the terminal, but not once per attempt.
  let rejected = 0;
  let lastWarn = 0;
  const warnRejected = (origin: string) => {
    rejected++;
    const now = Date.now();
    if (now - lastWarn < 10_000) return;
    lastWarn = now;
    const safe = origin.replace(/[^\x20-\x7e]/g, '?').slice(0, 100) || '(none)';
    console.warn(`[bridge] rejected ${rejected === 1 ? 'a connection' : `${rejected} connections`} from origin "${safe}"${rejected > 1 ? ' and others' : ''}`);
    rejected = 0;
  };

  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    checkClient(req)
      .then(({ problem, access: who }) => {
        if (socket.destroyed) return;
        if (who) accessOf.set(req, who);
        upgrade(req, socket, head, problem);
      })
      .catch(() => socket.destroy());
  });
  const upgrade = (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, problem: string | null) => {
    const origin = (req.headers.origin ?? '').replace(/\/$/, '');
    const path = (req.url ?? '').split('?')[0];
    if (problem) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      refusedLog(`refused a connection: ${problem}`);
      return;
    }
    // Let in by Cloudflare Access: only the Cloudflare hostname's own page may connect (not lg.scoty.uk or the LAN
    // addresses, which could share a site — and the Access cookie — with it).
    const origins = accessOf.has(req) ? accessOrigins : config.allowedOrigins;
    if (path !== RPC_PATH || !hostAllowed(req.headers.host, listeningPort(), publicHosts) || !origins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      if (path === RPC_PATH) warnRejected(origin);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  wss.on('connection', (ws: WebSocket, req: import('node:http').IncomingMessage) => {
    const client = (req.socket.remoteAddress ?? '?').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
    // Pairing attempts are rate-limited in LAN mode, per device (IPv4 address or IPv6 /64) — including ones that
    // arrive from this computer, which a relay (ssh -R, a tunnel client) would look like. Not outside LAN mode: a few
    // stale tabs after a token reset mustn't lock the user out of the bridge on their own computer.
    const limited = !!lan;
    // Through Cloudflare Access every client arrives from cloudflared: rate-limit by who Access let in instead, and
    // end the connection when their Access session does.
    const who = accessOf.get(req);
    const key = who ? `access:${who.who.toLowerCase()}` : limiterKey(client);
    if (who) {
      const expiry = setTimeout(() => ws.close(4401, 'Cloudflare Access: sign in again'), Math.max(0, Math.min(who.expiresAt - Date.now(), ACCESS_CONNECTION_MS)));
      ws.once('close', () => clearTimeout(expiry));
    }
    // One pairing attempt at a time per connection, and a wrong one ends it: frames that arrive together can't each
    // try a token.
    let attempting = false;
    // A bad frame (too big, invalid UTF-8) ends this connection — without a listener it would end the process.
    ws.on('error', () => ws.terminate());
    let alive = true;
    ws.on('pong', () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    const session: Session = {
      authed: false,
      emit: (event, data) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event, data }));
      },
      waitForRoom: () =>
        ws.bufferedAmount < SEND_HIGH
          ? null
          : new Promise<void>((resolve) => {
              const t = setInterval(() => {
                if (ws.bufferedAmount < SEND_LOW || ws.readyState !== ws.OPEN) {
                  clearInterval(t);
                  resolve();
                }
              }, 50);
            }),
      uploads: new UploadStore(),
      streams: new Map(),
      shells: undefined as unknown as ShellSessions,
    };
    session.shells = new ShellSessions(pool, (event, data) => session.emit(event, data));
    sessions.add(session);
    // Unpaired sockets get a short window to authenticate.
    const authTimer = setTimeout(() => {
      if (!session.authed) ws.close(4401, 'pairing timeout');
    }, 10_000);

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      if (!session.authed && attempting) return; // dropped; the connection closes when the attempt fails
      // Too many pairing attempts from this device: it waits before it may try again.
      const wait = session.authed || !limited ? 0 : limiter.waitFor(key);
      if (wait) {
        let id: unknown;
        try {
          id = (JSON.parse(data.toString()) as { id?: unknown }).id;
        } catch {
          /* not JSON */
        }
        const message = `Too many wrong pairing tokens from this device. Try again in ${Math.ceil(wait / 1000)} seconds.`;
        if (typeof id === 'number') ws.send(JSON.stringify({ id, error: { code: ErrorCodes.RateLimited, message } }));
        ws.close(4429, 'rate limited');
        return;
      }
      const unauthed = !session.authed;
      if (unauthed) {
        attempting = true;
        // Counted before the token is checked (and forgiven once it's right): attempts that run at the same time on
        // other connections are counted too.
        if (limited) limiter.failed(key);
      }
      const res = await dispatch(data.toString(), session, { token: config.token, pool, repos, litefin, lgeUrl: config.lgeUrl, dev: config.dev, lan: !!lan, store });
      if (res && ws.readyState === ws.OPEN) ws.send(JSON.stringify(res));
      if (unauthed && session.authed) {
        if (limited) limiter.succeeded(key);
      } else if (unauthed) {
        if (res && 'error' in res && res.error.code === 'unauthorized') refusedLog(`a wrong pairing token from ${client}`);
        ws.close(4401, 'unauthorized');
      }
    });
    ws.on('close', () => {
      sessions.delete(session);
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      session.uploads.clear();
      for (const run of session.streams.values()) run.cancel();
      session.streams.clear();
      session.shells.closeAll();
    });
  });

  http.on('close', () => pool.close());

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => resolve(http));
  });
}
