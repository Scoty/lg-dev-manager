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
import { LitefinClient } from './litefin/litefin.js';
import { ShellSessions } from './shell/shells.js';

export const RPC_PATH = '/rpc';

/** Unanswered pings before a connection counts as gone (its shells, streams and uploads are then closed). */
const HEARTBEAT_MS = 30_000;
/** Output waits while this much is queued for a slow browser tab (Session.waitForRoom). */
const SEND_HIGH = 4 * 1024 * 1024;
const SEND_LOW = 1024 * 1024;

/** Requests must name this bridge as 127.0.0.1 or localhost: a page whose DNS name was re-pointed here can't. */
const hostAllowed = (host: string | undefined, port: number) =>
  host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;

export function startServer(
  config: BridgeConfig,
  pool = new SshPool(),
  repo = new RepoClient(config.repoUrl),
  litefin = new LitefinClient(config.litefinUrl),
): Promise<Server> {
  const http = createServer((req, res) => {
    if (!hostAllowed(req.headers.host, listeningPort())) {
      res.writeHead(421, { 'content-type': 'text/plain' }).end('Wrong host.');
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
  });

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
    const origin = (req.headers.origin ?? '').replace(/\/$/, '');
    const path = (req.url ?? '').split('?')[0];
    if (path !== RPC_PATH || !hostAllowed(req.headers.host, listeningPort()) || !config.allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      if (path === RPC_PATH) warnRejected(origin);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
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
    // Unpaired sockets get a short window to authenticate.
    const authTimer = setTimeout(() => {
      if (!session.authed) ws.close(4401, 'pairing timeout');
    }, 10_000);

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      const res = await dispatch(data.toString(), session, { token: config.token, pool, repo, litefin, lgeUrl: config.lgeUrl, dev: config.dev });
      if (res && ws.readyState === ws.OPEN) ws.send(JSON.stringify(res));
      if (res && 'error' in res && res.error.code === 'unauthorized' && !session.authed) {
        ws.close(4401, 'unauthorized');
      }
    });
    ws.on('close', () => {
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
