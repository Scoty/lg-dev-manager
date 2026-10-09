import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
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
