import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startMockGithub, startMockTv, type MockGithub, type MockTv } from '@lgdm/mock-tv';
import { PROTOCOL_VERSION } from '@lgdm/protocol';
import { startServer } from './server.js';
import { SshPool } from './ssh/pool.js';
import { RepoClient } from './repo/repo.js';
import { LitefinClient, versionOfTag } from './litefin/litefin.js';

const TOKEN = 'litefin-test-token';
const ORIGIN = 'http://localhost:5173';
let server: Server;
let gh: MockGithub;
let devTv: MockTv;
let hbTv: MockTv;
let ws: WebSocket;
let nextId = 1;
const frames: any[] = [];

function call(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
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

beforeAll(async () => {
  [gh, devTv, hbTv] = await Promise.all([startMockGithub(), startMockTv(), startMockTv({ username: 'root', password: 'alpine', hbchannel: true })]);
  server = await startServer(
    { host: '127.0.0.1', port: 0, allowedOrigins: [ORIGIN], token: TOKEN, dev: true },
    new SshPool(),
    new RepoClient('http://127.0.0.1:1/api'),
    new LitefinClient(gh.url),
  );
  ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`, { headers: { Origin: ORIGIN } });
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((r) => ws.once('open', r));
  await call('system.hello', { token: TOKEN, protocolVersion: PROTOCOL_VERSION });
});
afterAll(async () => {
  ws.close();
  await new Promise<void>((r) => server.close(() => r()));
  await Promise.all([gh.close(), devTv.close(), hbTv.close()]);
});

const devmode = () => ({ host: devTv.host, port: devTv.sshPort, username: 'prisoner', auth: { kind: 'key', privateKey: devTv.privateKey, passphrase: devTv.passphrase } });
const rooted = () => ({ host: hbTv.host, port: hbTv.sshPort, username: 'root', auth: { kind: 'password', password: 'alpine' } });

describe('litefin.list', () => {
  it('lists the last 5 published releases with their webOS builds', async () => {
    const res = (await call('litefin.list')).result;
    expect(res.releases.map((r: any) => r.tag)).toEqual(['v1.9.0', 'v1.8.0', 'v1.7.0', 'v1.6.0', 'v.1.5.1']);
    const latest = res.releases[0];
    expect(latest.version).toBe('1.9.0');
    // Tizen builds, manifest.json and IPKs hosted elsewhere are left out.
    expect(latest.assets.map((a: any) => a.variant).sort()).toEqual(['Legacy', 'Modern', 'Normal', 'Ultra-Legacy', 'Ultra-Legacy-NoService']);
    expect(latest.assets.every((a: any) => /^[0-9a-f]{64}$/.test(a.sha256) && a.size > 0)).toBe(true);
    expect(res.releases[2].assets.map((a: any) => a.variant).sort()).toEqual(['Legacy', 'Normal', 'Ultra-Legacy']);
    expect(res.releases[3].assets.find((a: any) => a.variant === 'Normal').sha256).toBeUndefined();
    expect(res.releases[4].version).toBe('1.5.1');
  });

  it('keeps the list for a while, and refreshes on request', async () => {
    const n = () => gh.requests.filter((r) => r.startsWith('/repos/')).length;
    const before = n();
    await call('litefin.list');
    expect(n()).toBe(before);
    await call('litefin.list', { refresh: true });
    expect(n()).toBe(before + 1);
  });

  it('says when GitHub’s rate limit is reached, and keeps showing the list it has', async () => {
    gh.rateLimited = true;
    try {
      const res = await call('litefin.list', { refresh: true });
      expect(res.result.releases).toHaveLength(5);
      expect(res.result.stale).toMatch(/60 requests an hour/);
      // Nothing fetched before: an error.
      const fresh = new LitefinClient(gh.url);
      await expect(fresh.list()).rejects.toMatchObject({ code: 'litefin_rate_limited' });
    } finally {
      gh.rateLimited = false;
    }
  });
});

describe('litefin.install', () => {
  it('installs a build with the Dev Mode installer', async () => {
    const res = await call('litefin.install', { device: devmode(), tag: 'v1.7.0', variant: 'Ultra-Legacy', opId: 'l1' });
    expect(res.result).toEqual({ appId: 'org.litefin.app', version: '1.7.0', via: 'devmode' });
    const app = devTv.state.apps.find((a) => a.id === 'org.litefin.app')!;
    expect(app.version).toBe('1.7.0');
    expect(app.title).toBe('Litefin Ultra-Legacy');
    // Progress and the GitHub download showed up for this client.
    expect(frames.some((f) => f.event === 'op.progress' && f.data.opId === 'l1')).toBe(true);
    expect(frames.some((f) => f.event === 'cmd.log' && /GET .*releases\/download\/v1\.7\.0\/Litefin-1\.7\.0-webOS-Ultra-Legacy\.ipk/.test(f.data.command))).toBe(true);
  });

  it('lets Homebrew Channel download it on a rooted TV (following GitHub’s redirect)', async () => {
    const res = await call('litefin.install', { device: rooted(), tag: 'v1.9.0', variant: 'Modern', opId: 'l2' });
    expect(res.result).toEqual({ appId: 'org.litefin.app', version: '1.9.0', via: 'hbchannel' });
    expect(hbTv.state.apps.find((a) => a.id === 'org.litefin.app')?.title).toBe('Litefin Modern');
  });

  it('installs a build without a digest on a rooted TV from a local copy (Homebrew Channel needs a checksum)', async () => {
    const res = await call('litefin.install', { device: rooted(), tag: 'v1.6.0', variant: 'Normal', opId: 'l7' });
    expect(res.result).toEqual({ appId: 'org.litefin.app', version: '1.6.0', via: 'hbchannel' });
    expect(hbTv.state.apps.find((a) => a.id === 'org.litefin.app')?.version).toBe('1.6.0');
    const runs = frames.filter((f) => f.event === 'cmd.log' && f.data.phase === 'start').map((f) => f.data.command as string);
    expect(runs.some((c) => c.includes('hbchannel.service/install') && c.includes('releases/download/v1.6.0'))).toBe(false); // never asked the TV to fetch it
  });

  it('refuses a download that doesn’t match GitHub’s checksum', async () => {
    const res = await call('litefin.install', { device: devmode(), tag: 'v1.8.0', variant: 'Legacy', opId: 'l3' });
    expect(res.error.code).toBe('checksum_mismatch');
    expect(devTv.state.apps.find((a) => a.id === 'org.litefin.app')?.version).toBe('1.7.0'); // unchanged
  });

  it('only installs builds from the list', async () => {
    expect((await call('litefin.install', { device: devmode(), tag: 'v1.7.0', variant: 'Modern', opId: 'l4' })).error.code).toBe('litefin_not_found');
    const beta = await call('litefin.install', { device: devmode(), tag: 'v2.0.0-beta.1', variant: 'Normal', opId: 'l5' });
    expect(beta.error).toMatchObject({ code: 'litefin_not_found', message: expect.stringMatching(/isn’t among the latest releases/) });
    expect((await call('litefin.install', { device: devmode(), tag: 'v1.9.0', variant: '../x', opId: 'l6' })).error.code).toBe('bad_request');
  });
});

describe('LitefinClient', () => {
  it('reads tags and keeps only this project’s release files', () => {
    expect(versionOfTag('v1.9.0')).toBe('1.9.0');
    expect(versionOfTag('v.0.45.1')).toBe('0.45.1');
    const c = new LitefinClient('https://api.github.com/repos/MoazSalem/litefin');
    expect(c.downloadPrefix).toBe('https://github.com/MoazSalem/litefin/releases/download/');
    const entries = c.parse([
      {
        tag_name: 'v1.0.0',
        published_at: '2026-01-01T00:00:00Z',
        assets: [
          { name: 'Litefin-1.0.0-webOS-Normal.ipk', size: 1, browser_download_url: 'https://github.com/MoazSalem/litefin/releases/download/v1.0.0/Litefin-1.0.0-webOS-Normal.ipk' },
          { name: 'Litefin-1.0.0-webOS-Modern.ipk', size: 1, browser_download_url: 'https://github.com/someone/else/releases/download/v1.0.0/Litefin-1.0.0-webOS-Modern.ipk' },
          { name: 'Litefin-1.0.0-webOS-Legacy.ipk', size: 1, browser_download_url: 'https://github.com/MoazSalem/litefin/releases/download/v9/Litefin-1.0.0-webOS-Legacy.ipk' },
        ],
      },
      { tag_name: 'v1.1.0-rc1', published_at: '2026-02-01T00:00:00Z', assets: [] },
      { tag_name: 'v0.9.0', published_at: '2025-12-01T00:00:00Z', assets: [{ name: 'Litefin-0.9.0-Tizen-Normal.wgt' }] },
    ]);
    expect(entries.map((e) => [e.release.tag, e.release.assets.map((a) => a.variant)])).toEqual([['v1.0.0', ['Normal']]]);
  });
});
