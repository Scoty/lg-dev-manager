import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startMockTv, type MockTv } from '@lgdm/mock-tv';
import { PROTOCOL_VERSION } from '@lgdm/protocol';
import { startServer } from './server.js';

const TOKEN = 'rpc-test-token';
const ORIGIN = 'http://localhost:5173';
let server: Server;
let tv: MockTv;
let ws: WebSocket;
let nextId = 1;
const frames: string[] = [];

function call(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    ws.on('message', function onMsg(raw) {
      frames.push(raw.toString());
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        ws.off('message', onMsg);
        resolve(msg);
      }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

beforeAll(async () => {
  tv = await startMockTv({ username: 'root', password: 'S3cr3t-pa55' });
  server = await startServer({ host: '127.0.0.1', port: 0, allowedOrigins: [ORIGIN], token: TOKEN, dev: true });
  ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`, { headers: { Origin: ORIGIN } });
  await new Promise((r) => ws.once('open', r));
  await call('system.hello', { token: TOKEN, protocolVersion: PROTOCOL_VERSION });
});
afterAll(async () => {
  ws.close();
  await new Promise<void>((r) => server.close(() => r()));
  await tv.close();
});

const device = (password: string) => ({ host: tv.host, port: tv.sshPort, username: 'root', auth: { kind: 'password', password } });

describe('device RPCs over WebSocket', () => {
  it('device.test reports root', async () => {
    const res = await call('device.test', { device: device('S3cr3t-pa55') });
    expect(res.result.root).toBe(true);
  });

  it('cmd.exec and luna.call work', async () => {
    expect((await call('cmd.exec', { device: device('S3cr3t-pa55'), command: 'echo hi' })).result.stdout).toBe('hi\n');
    const luna = await call('luna.call', { device: device('S3cr3t-pa55'), uri: 'luna://com.palm.systemservice/osInfo/query', public: false });
    expect(luna.result.webos_release).toBe('8.0.0');
  });

  it('rejects non-luna URIs (no shell injection through uri)', async () => {
    const res = await call('luna.call', { device: device('S3cr3t-pa55'), uri: 'luna://x; rm -rf /' });
    expect(res.error.code).toBe('bad_request');
  });

  it('never echoes credentials back in errors', async () => {
    const res = await call('cmd.exec', { device: device('WrongPassword-xyz'), command: 'id -u' });
    expect(res.error.code).toBe('ssh_auth_failed');
    expect(frames.join('\n')).not.toContain('WrongPassword-xyz');
    expect(frames.join('\n')).not.toContain('S3cr3t-pa55');
  });

  it('device.disconnect closes pooled connections', async () => {
    const res = await call('device.disconnect', {});
    expect(res.result.closed).toBeGreaterThanOrEqual(1);
  });
});
