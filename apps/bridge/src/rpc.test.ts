import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fakeIpk, startMockTv, type MockTv } from '@lgdm/mock-tv';
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

describe('uploads and installs over WebSocket', () => {
  const dev = () => device('S3cr3t-pa55');

  it('uploads in chunks, installs with op.progress events, and drops the upload', async () => {
    const ipk = fakeIpk('com.example.ws', '3.1.0', 'WS App', 150_000);
    const { result: begin } = await call('upload.begin', { name: 'ws.ipk', size: ipk.length });
    let offset = 0;
    while (offset < ipk.length) {
      const part = ipk.subarray(offset, offset + 64 * 1024);
      const res = await call('upload.chunk', { uploadId: begin.uploadId, offset, data: part.toString('base64') });
      offset += part.length;
      expect(res.result.received).toBe(offset);
    }
    const before = frames.length;
    const res = await call('apps.install', { device: dev(), uploadId: begin.uploadId, opId: 'op-1' });
    expect(res.result).toEqual({ appId: 'com.example.ws', via: 'devmode' });
    const progress = frames.slice(before).map((f) => JSON.parse(f)).filter((m) => m.event === 'op.progress');
    expect(progress.length).toBeGreaterThan(3);
    expect(progress.every((m) => m.data.opId === 'op-1')).toBe(true);
    expect(tv.state.apps.some((a) => a.id === 'com.example.ws')).toBe(true);
    const again = await call('apps.install', { device: dev(), uploadId: begin.uploadId, opId: 'op-2' });
    expect(again.error.code).toBe('upload_not_found');
  });

  it('rejects out-of-order chunks and incomplete uploads', async () => {
    const { result } = await call('upload.begin', { name: 'x.ipk', size: 10 });
    const bad = await call('upload.chunk', { uploadId: result.uploadId, offset: 5, data: Buffer.from('12345').toString('base64') });
    expect(bad.error.code).toBe('bad_request');
    await call('upload.chunk', { uploadId: result.uploadId, offset: 0, data: Buffer.from('12345').toString('base64') });
    const res = await call('apps.install', { device: dev(), uploadId: result.uploadId, opId: 'op-3' });
    expect(res.error.code).toBe('upload_incomplete');
    expect((await call('upload.discard', { uploadId: result.uploadId })).result).toEqual({});
  });

  it('rejects uploads larger than announced', async () => {
    const { result } = await call('upload.begin', { name: 'x.ipk', size: 3 });
    const res = await call('upload.chunk', { uploadId: result.uploadId, offset: 0, data: Buffer.from('12345').toString('base64') });
    expect(res.error.code).toBe('upload_too_large');
  });

  it('validates app ids and icon paths before touching the TV', async () => {
    expect((await call('apps.launch', { device: dev(), id: 'x; reboot' })).error.code).toBe('bad_request');
    expect((await call('apps.icon', { device: dev(), path: '/media/../etc/shadow.png' })).error.code).toBe('bad_request');
    expect((await call('apps.icon', { device: dev(), path: 'relative.png' })).error.code).toBe('bad_request');
  });

  it('lists, launches and removes apps', async () => {
    const list = await call('apps.list', { device: dev() });
    expect(list.result.apps.map((a: { id: string }) => a.id)).toContain('com.example.ws');
    expect((await call('apps.launch', { device: dev(), id: 'com.example.ws' })).result).toEqual({});
    expect((await call('apps.remove', { device: dev(), id: 'com.example.ws', opId: 'op-4' })).result).toEqual({});
  });
});

describe('upload budget', () => {
  it('is shared and held until released, and memory grows only as data arrives', async () => {
    const { UploadBudget, UploadStore } = await import('./rpc/uploads.js');
    const budget = new UploadBudget(100);
    const a = new UploadStore(budget);
    const b = new UploadStore(budget);
    const id = a.begin('a.ipk', 60);
    expect(() => b.begin('b.ipk', 60)).toThrow(expect.objectContaining({ code: 'upload_too_large' }));
    a.chunk(id, 0, Buffer.alloc(60, 1).toString('base64'));
    const taken = a.take(id);
    expect(taken.data.length).toBe(60);
    expect(budget.inUse).toBe(60); // still reserved while installing
    taken.done();
    expect(budget.inUse).toBe(0);
    const id2 = b.begin('b.ipk', 60);
    b.clear();
    expect(budget.inUse).toBe(0);
    expect(() => b.take(id2)).toThrow(expect.objectContaining({ code: 'upload_not_found' }));
  });
});
