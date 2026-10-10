import type { AddressInfo } from 'node:net';
import { request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@lgdm/protocol';
import { startServer } from './server.js';

const TOKEN = 'test-token-123';
const ORIGIN = 'http://localhost:5173';
let server: Server;
let url: string;

beforeAll(async () => {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: [ORIGIN],
    token: TOKEN,
    dev: true,
  });
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function open(origin = ORIGIN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: origin } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function call(ws: WebSocket, id: number, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve) => {
    ws.on('message', function onMsg(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        ws.off('message', onMsg);
        resolve(msg);
      }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

describe('bridge server', () => {
  it('rejects unknown origins', async () => {
    await expect(open('https://evil.example')).rejects.toThrow(/403/);
  });

  it('refuses calls before pairing', async () => {
    const ws = await open();
    const res = await call(ws, 1, 'system.ping');
    expect(res.error.code).toBe('unauthorized');
  });

  it('refuses a wrong token', async () => {
    const ws = await open();
    const res = await call(ws, 1, 'system.hello', { token: 'nope', protocolVersion: PROTOCOL_VERSION });
    expect(res.error.code).toBe('unauthorized');
  });

  it('pairs with the right token and then answers', async () => {
    const ws = await open();
    const hello = await call(ws, 1, 'system.hello', { token: TOKEN, protocolVersion: PROTOCOL_VERSION });
    expect(hello.result.protocolVersion).toBe(PROTOCOL_VERSION);
    const ping = await call(ws, 2, 'system.ping');
    expect(typeof ping.result.now).toBe('number');
    ws.close();
  });

  it('reports unknown methods', async () => {
    const ws = await open();
    await call(ws, 1, 'system.hello', { token: TOKEN, protocolVersion: PROTOCOL_VERSION });
    const res = await call(ws, 2, 'nope.nothing');
    expect(res.error.code).toBe('unknown_method');
    ws.close();
  });
});

describe('bridge server under abuse', () => {
  let web: Server;
  let port: number;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'lgdm-web-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>ui</title>');
    web = await startServer({ host: '127.0.0.1', port: 0, allowedOrigins: [ORIGIN], token: TOKEN, webRoot: root, dev: false });
    port = (web.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => web.close(() => r())));

  const get = (path: string, host = `127.0.0.1:${port}`) =>
    new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
      req.on('error', reject);
      req.end();
    });
  const alive = async () => expect((await get('/healthz')).status).toBe(200);

  it('answers malformed paths with 400 and keeps running', async () => {
    expect((await get('/%E0%A4%A')).status).toBe(400);
    expect((await get('/%')).status).toBe(400);
    await alive();
  });

  it('serves the UI with frame protection and no path traversal', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await get('/..%2f..%2fetc%2fpasswd')).status).toBe(403);
  });

  it('refuses requests for another host name (DNS rebinding)', async () => {
    expect((await get('/', `attacker.example:${port}`)).status).toBe(421);
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { Origin: ORIGIN, Host: `attacker.example:${port}` } });
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
    ).rejects.toThrow(/403/);
  });

  it('survives a frame that is too big or not UTF-8, before pairing', async () => {
    for (const bad of [Buffer.alloc(17 * 1024 * 1024, 0x61), Buffer.from([0xff, 0xfe, 0xfd])]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { Origin: ORIGIN } });
      await new Promise((r) => ws.once('open', r));
      const closed = new Promise((r) => ws.once('close', r));
      ws.on('error', () => {});
      ws.send(bad, { binary: false });
      await closed;
    }
    await alive();
  });

  it('hides stack traces unless started with --dev', async () => {
    const { dispatch } = await import('./rpc/dispatch.js');
    const session = { authed: true } as never;
    const boom = { get pool(): never { throw new Error('boom'); } } as never;
    const res = await dispatch(JSON.stringify({ id: 1, method: 'cmd.exec', params: { device: { host: '192.0.2.1', port: 22, username: 'root', auth: { kind: 'password', password: 'x' } }, command: 'true' } }), session, boom);
    expect(res && 'error' in res && res.error.detail).toBe('boom');
  });
});

describe('local page packed into the standalone app', () => {
  let web: Server;
  let base: string;
  const files = new Map<string, Uint8Array>([
    ['index.html', Buffer.from('<!doctype html><title>packed</title>')],
    ['assets/app.js', Buffer.from('console.log(1)')],
  ]);

  beforeAll(async () => {
    web = await startServer({ host: '127.0.0.1', port: 0, allowedOrigins: [ORIGIN], token: TOKEN, webRoot: files, dev: false });
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => web.close(() => r())));

  it('serves the packed files, and the page for any other path', async () => {
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toBe('console.log(1)');
    for (const path of ['/', '/devices', '/assets/../../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(await res.text()).toContain('packed');
    }
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const head = await fetch(`${base}/assets/app.js`, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('14');
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });
});
