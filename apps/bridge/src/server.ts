import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BridgeConfig } from './config.js';
import { dispatch } from './rpc/dispatch.js';
import type { Session } from './rpc/handlers.js';
import { serveStatic } from './http/static.js';
import { BRIDGE_VERSION } from './version.js';
import { SshPool } from './ssh/pool.js';
import { UploadStore } from './rpc/uploads.js';

export const RPC_PATH = '/rpc';

export function startServer(config: BridgeConfig, pool = new SshPool()): Promise<Server> {
  const http = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, version: BRIDGE_VERSION }));
      return;
    }
    if (config.webRoot) return serveStatic(config.webRoot, req, res);
    res.writeHead(200, { 'content-type': 'text/plain' }).end(
      `LG Dev Manager bridge ${BRIDGE_VERSION} is running. Open the web app and pair with this bridge.`,
    );
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
  });

  http.on('upgrade', (req, socket, head) => {
    const origin = (req.headers.origin ?? '').replace(/\/$/, '');
    const path = (req.url ?? '').split('?')[0];
    if (path !== RPC_PATH || !config.allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      if (path === RPC_PATH) console.warn(`[bridge] rejected connection from origin "${origin || '(none)'}"`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const session: Session = {
      authed: false,
      emit: (event, data) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event, data }));
      },
      uploads: new UploadStore(),
    };
    // Unpaired sockets get a short window to authenticate.
    const authTimer = setTimeout(() => {
      if (!session.authed) ws.close(4401, 'pairing timeout');
    }, 10_000);

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      const res = await dispatch(data.toString(), session, { token: config.token, pool });
      if (res && ws.readyState === ws.OPEN) ws.send(JSON.stringify(res));
      if (res && 'error' in res && res.error.code === 'unauthorized' && !session.authed) {
        ws.close(4401, 'unauthorized');
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      session.uploads.clear();
    });
  });

  http.on('close', () => pool.close());

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => resolve(http));
  });
}
