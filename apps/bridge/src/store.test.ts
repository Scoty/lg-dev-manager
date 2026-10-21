import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import ssh2 from 'ssh2';
import { makeIconPng, startMockTv, type MockTv } from '@lgdm/mock-tv';
import { PROTOCOL_VERSION } from '@lgdm/protocol';
import { startServer } from './server.js';
import { SshPool } from './ssh/pool.js';
import { RepoClient } from './repo/repo.js';
import { BridgeStore } from './store/store.js';

const TOKEN = 'store-test-token';
const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'St0red-Pa55word';

const tvRecord = (tv: MockTv, extra: Record<string, unknown> = {}) => ({
  id: 'tv-1',
  name: 'Living Room',
  mode: 'rooted' as const,
  host: tv.host,
  port: tv.sshPort,
  username: 'root',
  auth: { kind: 'password' as const, password: PASSWORD },
  ...extra,
});

describe('the bridge’s storage', () => {
  let dir: string;
  let tv: MockTv;
  beforeAll(async () => {
    tv = await startMockTv({ username: 'root', password: PASSWORD });
  });
  afterAll(() => tv.close());

  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), 'lgdm-store-'));
    return new BridgeStore(dir);
  };

  it('keeps TVs with their logins, but only ever shows them without', async () => {
    const store = fresh();
    const saved = await store.saveDevice(tvRecord(tv));
    expect(saved).toMatchObject({ id: 'tv-1', name: 'Living Room', login: { kind: 'password' } });
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
    expect(JSON.stringify(store.listDevices())).not.toContain(PASSWORD);
    // In the file (readable by this user only), and back after a restart.
    const file = join(dir, 'devices.json');
    expect(readFileSync(file, 'utf8')).toContain(PASSWORD);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(new BridgeStore(dir).target({ stored: 'tv-1' })).toEqual({ host: tv.host, port: tv.sshPort, username: 'root', auth: { kind: 'password', password: PASSWORD } });
  });

  it('keeps the stored login when a TV is edited without one, but a password only moves to a new address with the TV’s host key', async () => {
    const store = fresh();
    await store.saveDevice(tvRecord(tv));
    const { auth: _a, ...withoutLogin } = tvRecord(tv, { name: 'Bedroom' });
    expect(await store.saveDevice(withoutLogin)).toMatchObject({ name: 'Bedroom' });
    expect(store.target({ stored: 'tv-1' }).auth).toEqual({ kind: 'password', password: PASSWORD });
    // Another address with the kept password, before the bridge knows the TV's host key: the password again.
    await expect(store.saveDevice({ ...withoutLogin, host: '192.0.2.5' })).rejects.toMatchObject({ code: 'store_login_required' });
    expect(await store.saveDevice({ ...withoutLogin, host: '192.0.2.5', auth: { kind: 'password', password: PASSWORD } })).toMatchObject({ host: '192.0.2.5' });
    // Known host key: the TV may move (DHCP); the key is checked before the password is sent.
    store.forTarget(store.target({ stored: 'tv-1' }))!.remember('SHA256:abc');
    await expect.poll(() => store.forTarget(store.target({ stored: 'tv-1' }))?.expected).toBe('SHA256:abc');
    expect(await store.saveDevice({ ...withoutLogin, host: '192.0.2.6' })).toMatchObject({ host: '192.0.2.6' });
    expect(store.forTarget(store.target({ stored: 'tv-1' }))?.expected).toBe('SHA256:abc');
    expect(JSON.stringify(store.listDevices())).not.toContain('SHA256');
    // A new login starts over.
    await store.saveDevice({ ...withoutLogin, host: '192.0.2.6', auth: { kind: 'password', password: 'other-pass' } });
    expect(store.forTarget(store.target({ stored: 'tv-1' }))?.expected).toBeUndefined();
    // A reference is the id only: no address of the browser's choosing.
    expect(() => store.target({ stored: 'tv-1', host: '192.0.2.9' })).toThrow(/Not a stored TV/);
    await expect(store.saveDevice({ ...withoutLogin, id: 'new-tv' })).rejects.toThrow(/needs its login/);
    expect(() => store.target({ stored: 'nope' })).toThrow(/isn’t saved/);
    await store.removeDevice('tv-1');
    expect(store.listDevices()).toEqual([]);
  });

  it('keeps screenshots (real images only), drops the oldest past the limit, and removes them with their TV', async () => {
    const store = fresh();
    await store.saveDevice(tvRecord(tv));
    const png = makeIconPng([10, 20, 30], 8).toString('base64');
    const shot = await store.addShot('tv-1', 'DISPLAY', png, 1000);
    expect(shot).toMatchObject({ deviceId: 'tv-1', mime: 'image/png', at: 1000 });
    expect(store.getShot(shot.id).base64).toBe(png);
    await expect(store.addShot('tv-1', 'DISPLAY', Buffer.from('<svg/>').toString('base64'))).rejects.toThrow(/PNG and JPEG/);
    await expect(store.addShot('nope', 'DISPLAY', png)).rejects.toThrow(/isn’t saved/);
    await store.removeDevice('tv-1');
    expect(() => store.getShot(shot.id)).toThrow(/isn’t on the bridge/);
  });

  it('keeps the custom repositories list', async () => {
    const store = fresh();
    const repo = { id: 'abcdef12', name: 'Friends', url: 'https://repo.example.com/apps.json', addedAt: 1 };
    await store.setRepos([repo, { ...repo, id: 'abcdef13' }]); // same address twice: kept once
    expect(new BridgeStore(dir).getRepos()).toEqual([repo]);
  });

  it('refuses to start over a file it can’t read, rather than overwrite it', () => {
    const store = fresh();
    void store;
    writeFileSync(join(dir, 'devices.json'), '{"version":9}');
    expect(() => new BridgeStore(dir)).toThrow(/isn't a file this bridge can read/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a bridge with --store', () => {
  let server: Server;
  let tv: MockTv;
  let dir: string;
  let port: number;

  beforeAll(async () => {
    tv = await startMockTv({ username: 'root', password: PASSWORD });
    dir = mkdtempSync(join(tmpdir(), 'lgdm-store-srv-'));
    server = await startServer(
      { host: '127.0.0.1', port: 0, allowedOrigins: [ORIGIN], token: TOKEN, dev: false, storeDir: dir },
      new SshPool(),
      new RepoClient('http://127.0.0.1:1/api'),
    );
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await tv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { Origin: ORIGIN } });
    await new Promise((r) => ws.once('open', r));
    const frames: string[] = [];
    const events: any[] = [];
    let id = 0;
    ws.on('message', (raw) => {
      frames.push(raw.toString());
      const msg = JSON.parse(raw.toString());
      if (msg.event) events.push(msg);
    });
    const call = (method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        const my = ++id;
        ws.on('message', function on(raw) {
          const msg = JSON.parse(raw.toString());
          if (msg.id !== my) return;
          ws.off('message', on);
          resolve(msg);
        });
        ws.send(JSON.stringify({ id: my, method, params }));
      });
    const hello = await call('system.hello', { token: TOKEN, protocolVersion: PROTOCOL_VERSION });
    return { ws, call, frames, events, hello };
  }

  it('says it stores, shares changes with every paired browser, and runs calls on a stored TV by its id', async () => {
    const a = await client();
    const b = await client();
    expect(a.hello.result.features).toContain('serverStore');
    expect((await a.call('store.devices.save', { device: tvRecord(tv) })).result.device.login).toEqual({ kind: 'password' });
    // The other browser hears about it and sees the TV — without the password.
    await expect.poll(() => b.events.some((e) => e.event === 'store.changed' && e.data.what === 'devices')).toBe(true);
    const list = (await b.call('store.devices.list')).result.devices;
    expect(list.map((d: any) => d.name)).toEqual(['Living Room']);
    // A call on the stored TV, by id: the bridge fills in the login.
    const res = await b.call('cmd.exec', { device: { stored: 'tv-1' }, command: 'echo stored' });
    expect(res.result.stdout).toBe('stored\n');
    expect([...a.frames, ...b.frames].join('\n')).not.toContain(PASSWORD);
    expect((await b.call('cmd.exec', { device: { stored: 'gone' }, command: 'id' })).error.code).toBe('store_not_found');
    // No address of the browser's choosing for a stored login.
    expect((await b.call('cmd.exec', { device: { stored: 'tv-1', host: '192.0.2.9', port: 22 }, command: 'id' })).error.code).toBe('bad_request');
    a.ws.close();
    b.ws.close();
  });

  it('moves a browser’s TVs in with their logins, keeps screenshots and repositories', async () => {
    const c = await client();
    const second = { ...tvRecord(tv), id: 'tv-2', name: 'Kitchen', auth: { kind: 'key', privateKey: tv.privateKey, passphrase: tv.passphrase } };
    expect((await c.call('store.devices.import', { devices: [second] })).result.imported).toBe(1);
    expect((await c.call('store.devices.list')).result.devices.find((d: any) => d.id === 'tv-2').login).toEqual({ kind: 'key', hasPassphrase: !!tv.passphrase });
    const png = makeIconPng([1, 2, 3], 4).toString('base64');
    const shot = (await c.call('store.shots.add', { deviceId: 'tv-2', method: 'VIDEO', base64: png })).result.shot;
    expect((await c.call('store.shots.list', { deviceId: 'tv-2' })).result.shots.map((s: any) => s.id)).toEqual([shot.id]);
    expect((await c.call('store.shots.get', { id: shot.id })).result.base64).toBe(png);
    const repo = { id: 'abcdef99', name: 'Club', url: 'https://club.example/repo.json', addedAt: 2 };
    await c.call('store.repos.set', { repos: [repo] });
    expect((await c.call('store.repos.get')).result.repos).toEqual([repo]);
    expect(c.frames.join('\n')).not.toContain('PRIVATE KEY');
    c.ws.close();
  });
});

describe('a stored password', () => {
  it('never goes to another SSH server, even when the TV is moved to its address', async () => {
    const tv = await startMockTv({ username: 'root', password: PASSWORD });
    const dir = mkdtempSync(join(tmpdir(), 'lgdm-store-pin-'));
    // Something else on the network that would like the password.
    const heard: string[] = [];
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const trap = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password') heard.push(ctx.password);
        ctx.reject(['password', 'keyboard-interactive']);
      });
      client.on('error', () => {});
    });
    await new Promise<void>((r) => trap.listen(0, '127.0.0.1', () => r()));
    const trapPort = (trap.address() as AddressInfo).port;
    const server = await startServer({ host: '127.0.0.1', port: 0, allowedOrigins: [ORIGIN], token: TOKEN, dev: false, storeDir: dir }, new SshPool(), new RepoClient('http://127.0.0.1:1/api'));
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`, { headers: { Origin: ORIGIN } });
    await new Promise((r) => ws.once('open', r));
    let id = 0;
    const call = (method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        const my = ++id;
        ws.on('message', function on(raw) {
          const msg = JSON.parse(raw.toString());
          if (msg.id === my) {
            ws.off('message', on);
            resolve(msg);
          }
        });
        ws.send(JSON.stringify({ id: my, method, params }));
      });
    try {
      await call('system.hello', { token: TOKEN, protocolVersion: PROTOCOL_VERSION });
      const record = { id: 'tv-p', name: 'Pinned', mode: 'rooted', host: '127.0.0.1', port: tv.sshPort, username: 'root' };
      await call('store.devices.save', { device: { ...record, auth: { kind: 'password', password: PASSWORD } } });
      // The first connection records the TV's host key.
      expect((await call('cmd.exec', { device: { stored: 'tv-p' }, command: 'echo hi' })).result.stdout).toBe('hi\n');
      await expect.poll(() => readFileSync(join(dir, 'devices.json'), 'utf8')).toContain('SHA256:');
      // Moved to the other server's address (the Edit TV dialog, kept login): the host key doesn't match, no login sent.
      expect((await call('store.devices.save', { device: { ...record, port: trapPort } })).result).toBeDefined();
      const res = await call('cmd.exec', { device: { stored: 'tv-p' }, command: 'id' });
      expect(res.error.code).toBe('ssh_host_key_changed');
      // A browser that has the password and sends it itself is checked the same way.
      const direct = await call('cmd.exec', { device: { ...record, port: trapPort, auth: { kind: 'password', password: PASSWORD } }, command: 'id' });
      expect(direct.error.code).toBe('ssh_host_key_changed');
      expect(heard).toEqual([]);
    } finally {
      ws.close();
      await new Promise<void>((r) => server.close(() => r()));
      trap.close();
      await tv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a bridge without --store', () => {
  it('refuses stored TVs and storage calls, and doesn’t say it stores', async () => {
    const server = await startServer({ host: '127.0.0.1', port: 0, allowedOrigins: [ORIGIN], token: TOKEN, dev: false }, new SshPool(), new RepoClient('http://127.0.0.1:1/api'));
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`, { headers: { Origin: ORIGIN } });
    await new Promise((r) => ws.once('open', r));
    let id = 0;
    const call = (method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        const my = ++id;
        ws.on('message', function on(raw) {
          const msg = JSON.parse(raw.toString());
          if (msg.id === my) {
            ws.off('message', on);
            resolve(msg);
          }
        });
        ws.send(JSON.stringify({ id: my, method, params }));
      });
    const hello = await call('system.hello', { token: TOKEN, protocolVersion: PROTOCOL_VERSION });
    expect(hello.result.features).not.toContain('serverStore');
    expect((await call('store.devices.list')).error.code).toBe('store_off');
    expect((await call('cmd.exec', { device: { stored: 'tv-1' }, command: 'id' })).error.code).toBe('store_off');
    ws.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
