import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fakeIpk, startMockRepo, startMockTv, type MockRepo, type MockTv } from '@lgdm/mock-tv';
import { PROTOCOL_VERSION } from '@lgdm/protocol';
import { startServer } from './server.js';
import { SshPool } from './ssh/pool.js';
import { RepoClient } from './repo/repo.js';

const TOKEN = 'rpc-test-token';
const ORIGIN = 'http://localhost:5173';
let server: Server;
let tv: MockTv;
let repo: MockRepo;
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
  repo = await startMockRepo();
  server = await startServer({ host: '127.0.0.1', port: 0, allowedOrigins: [ORIGIN], token: TOKEN, dev: true }, new SshPool(), new RepoClient(repo.url));
  ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`, { headers: { Origin: ORIGIN } });
  await new Promise((r) => ws.once('open', r));
  await call('system.hello', { token: TOKEN, protocolVersion: PROTOCOL_VERSION });
});
afterAll(async () => {
  ws.close();
  await new Promise<void>((r) => server.close(() => r()));
  await Promise.all([tv.close(), repo.close()]);
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

describe('console: cmd.log and cmd.stream', () => {
  const dev = () => device('S3cr3t-pa55');
  const events = (from: number, name: string) =>
    frames.slice(from).map((f) => JSON.parse(f)).filter((m) => m.event === name).map((m) => m.data);

  it('reports every SSH command a call runs, without credentials', async () => {
    const before = frames.length;
    await call('apps.list', { device: dev() });
    const logs = events(before, 'cmd.log');
    expect(logs.map((l) => l.phase)).toEqual(['start', 'end']);
    expect(logs[0]).toMatchObject({ kind: 'exec', target: `root@${tv.host}:${tv.sshPort}` });
    expect(logs[0].command).toContain('luna://com.webos.applicationManager/dev/listApps');
    expect(logs[1]).toMatchObject({ exitCode: 0 });
    expect(logs[1].output).toContain('com.example.hello');
    expect(JSON.stringify(logs)).not.toContain('S3cr3t-pa55');
  });

  it('marks icon reads as quiet', async () => {
    const before = frames.length;
    await call('apps.icon', { device: dev(), path: '/media/developer/apps/usr/palm/applications/com.example.hello/icon.png' });
    const logs = events(before, 'cmd.log');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.quiet === true)).toBe(true);
  });

  it('streams a typed command and its output', async () => {
    const before = frames.length;
    const res = await call('cmd.stream', { device: dev(), command: 'uname -a', opId: 'c1' });
    expect(res.result).toEqual({ exitCode: 0, cancelled: false });
    const out = events(before, 'cmd.output');
    expect(out.map((o) => o.data).join('')).toContain('Linux mock-tv');
    expect(out.every((o) => o.opId === 'c1' && o.stream === 'stdout')).toBe(true);
    expect(events(before, 'cmd.log')).toEqual([]); // typed commands aren't duplicated in the log
  });

  it('reports failing commands and stderr', async () => {
    const before = frames.length;
    const res = await call('cmd.stream', { device: dev(), command: 'nosuchcommand', opId: 'c2' });
    expect(res.result.exitCode).toBe(127);
    expect(events(before, 'cmd.output')).toEqual([{ opId: 'c2', stream: 'stderr', data: 'sh: nosuchcommand: not found\n' }]);
  });

  it('cancels a long-running command', async () => {
    const running = call('cmd.stream', { device: dev(), command: 'sleep 1000', opId: 'c3' });
    await new Promise((r) => setTimeout(r, 300));
    expect((await call('cmd.cancel', { opId: 'c3' })).result).toEqual({ cancelled: true });
    expect((await running).result).toMatchObject({ cancelled: true });
    expect((await call('cmd.cancel', { opId: 'c3' })).result).toEqual({ cancelled: false });
  });
});

describe('console: early cancel', () => {
  it('honours a cancel sent before the channel is open', async () => {
    const running = call('cmd.stream', { device: device('S3cr3t-pa55'), command: 'sleep 1000', opId: 'c9' });
    expect((await call('cmd.cancel', { opId: 'c9' })).result).toEqual({ cancelled: true });
    expect((await running).result).toEqual({ exitCode: null, cancelled: true });
  });
});

describe('Homebrew repository over WebSocket', () => {
  const dev = () => device('S3cr3t-pa55');

  it('lists the repository and logs the fetch as a quiet console step', async () => {
    const before = frames.length;
    const res = await call('repo.list', {});
    expect(res.result.packages.length).toBe(repo.apps.length);
    const logs = frames.slice(before).map((f) => JSON.parse(f)).filter((m) => m.event === 'cmd.log');
    expect(logs.some((m) => m.data.kind === 'http' && m.data.quiet && m.data.command === `GET ${repo.url}/apps.json`)).toBe(true);
  });

  it('serves descriptions and validates ids', async () => {
    expect((await call('repo.description', { id: 'com.example.repoapp' })).result.html).toContain('<h2>About</h2>');
    expect((await call('repo.description', { id: '../../etc/passwd' })).error.code).toBe('bad_request');
  });

  it('reports Homebrew Channel and installs from the repository with progress', async () => {
    expect((await call('device.hbchannel', { device: dev(), quiet: true })).result).toEqual({ installed: false, root: false });
    const before = frames.length;
    const res = await call('apps.installFromRepo', { device: dev(), id: 'com.example.beta', opId: 'op-repo' });
    expect(res.result).toEqual({ appId: 'com.example.beta', version: '1.0.0', via: 'devmode' });
    const progress = frames.slice(before).map((f) => JSON.parse(f)).filter((m) => m.event === 'op.progress' && m.data.opId === 'op-repo');
    expect(progress.map((p) => p.data.stage)).toEqual(expect.arrayContaining(['upload', 'install']));
  });
});

describe('files and shells over WebSocket', () => {
  const dev = () => device('S3cr3t-pa55');

  it('lists the home folder and reads a file', async () => {
    const home = (await call('files.home', { device: dev() })).result.path;
    expect(home).toBe('/home/root');
    const list = await call('files.list', { device: dev(), path: home });
    expect(list.result.items.map((i: { name: string }) => i.name)).toContain('notes.txt');
    const read = await call('files.read', { device: dev(), path: `${home}/notes.txt`, offset: 0, length: 65536 });
    expect(Buffer.from(read.result.data, 'base64').toString()).toContain('Hello from the mock TV');
    expect((await call('files.list', { device: dev(), path: '/media/../etc' })).error.code).toBe('bad_request');
  });

  it('uploads into a folder with progress', async () => {
    const begin = await call('upload.begin', { name: 'hi.txt', size: 5 });
    await call('upload.chunk', { uploadId: begin.result.uploadId, offset: 0, data: Buffer.from('hello').toString('base64') });
    const before = frames.length;
    const res = await call('files.write', { device: dev(), path: '/home/root/hi.txt', uploadId: begin.result.uploadId, opId: 'op-up' });
    expect(res.result).toEqual({ size: 5 });
    expect(tv.state.files.get('/home/root/hi.txt')?.toString()).toBe('hello');
    const progress = frames.slice(before).map((f) => JSON.parse(f)).filter((m) => m.event === 'op.progress' && m.data.opId === 'op-up');
    expect(progress.at(-1)?.data.percent).toBe(100);
  });

  it('runs a terminal and streams its output as events', async () => {
    const seen: string[] = [];
    const listen = (raw: WebSocket.RawData) => seen.push(raw.toString());
    ws.on('message', listen);
    const { shellId, pty } = (await call('shell.open', { device: dev(), rows: 24, cols: 80 })).result;
    expect(pty).toBe(true);
    await call('shell.write', { shellId, data: 'whoami\r' });
    const text = () =>
      seen
        .map((f) => JSON.parse(f))
        .filter((m) => m.event === 'shell.output' && m.data.shellId === shellId)
        .map((m) => Buffer.from(m.data.data, 'base64').toString())
        .join('');
    for (let i = 0; i < 100 && !text().includes('root\r\n'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(text()).toContain('root\r\n');
    ws.off('message', listen);
    await call('shell.close', { shellId });
    expect((await call('shell.write', { shellId, data: 'x' })).error.code).toBe('shell_not_found');
  });
});
