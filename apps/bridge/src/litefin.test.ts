import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fakeIpk, startMockGithub, startMockTv, type MockGithub, type MockTv } from '@lgdm/mock-tv';
import { ipkBuildTime } from './litefin/buildTime.js';
import { startServer } from './server.js';
import { connect, type TestClient } from './testing/rpcClient.js';
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
let client: TestClient;
let frames: any[] = [];

const call = (method: string, params?: unknown): Promise<any> => client.call(method, params);

beforeAll(async () => {
  [gh, devTv, hbTv] = await Promise.all([startMockGithub(), startMockTv(), startMockTv({ username: 'root', password: 'alpine', hbchannel: true })]);
  server = await startServer(
    { host: '127.0.0.1', port: 0, allowedOrigins: [ORIGIN], token: TOKEN, dev: true, litefinDevUrl: gh.devUrl },
    new SshPool(),
    new RepoClient('http://127.0.0.1:1/api'),
    new LitefinClient(gh.url),
  );
  client = await connect(server, { origin: ORIGIN, token: TOKEN });
  ws = client.ws;
  frames = client.messages;
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

describe('Litefin dev builds', () => {
  it('lists the latest dev builds with their build number, commit and message (all on one version)', async () => {
    const res = (await call('litefin.list', { channel: 'dev' })).result;
    // #102 is still building (no files yet): left out.
    expect(res.releases.map((r: any) => r.tag)).toEqual(['dev-b101-0ac5e76', 'dev-b100-0adcb34', 'dev-b99-4485d43', 'dev-b98-8406c0d', 'dev-b97-ebaf422']);
    const latest = res.releases[0];
    expect(latest).toMatchObject({
      version: '2.0.350',
      title: 'Litefin Dev Build #101 (0ac5e76)',
      // Plain text, as written (the page never renders it as HTML).
      build: { number: 101, commit: '0ac5e76', message: 'fix(webos): use the dvh1 hint <b>even</b> when canPlayType reports empty' },
    });
    expect(latest.assets.map((a: any) => a.variant).sort()).toEqual(['Legacy', 'Modern', 'Normal', 'Ultra-Legacy', 'Ultra-Legacy-NoService']);
    expect(latest.assets.find((a: any) => a.variant === 'Normal').name).toBe('Litefin-2.0.350-webOS-Normal-0ac5e76.ipk');
    expect(new Set(res.releases.map((r: any) => r.version))).toEqual(new Set(['2.0.350']));
    // The releases list is unchanged, without build details.
    expect((await call('litefin.list')).result.releases.every((r: any) => r.build === undefined && r.tag.startsWith('v'))).toBe(true);
  });

  it('installs a dev build from its own release, and keeps the two lists apart', async () => {
    const res = await call('litefin.install', { device: devmode(), tag: 'dev-b100-0adcb34', variant: 'Normal', opId: 'd1', channel: 'dev' });
    expect(res.result).toEqual({ appId: 'org.litefin.app', version: '2.0.350', via: 'devmode' });
    expect(devTv.state.apps.find((a) => a.id === 'org.litefin.app')?.version).toBe('2.0.350');
    expect(
      frames.some((f) => f.event === 'cmd.log' && /GET .*litefin-dev-builds\/releases\/download\/dev-b100-0adcb34\/Litefin-2\.0\.350-webOS-Normal-0adcb34\.ipk/.test(f.data.command)),
    ).toBe(true);
    // A dev build isn't a release, a release isn't a dev build, and a build still running has nothing to install.
    expect((await call('litefin.install', { device: devmode(), tag: 'dev-b100-0adcb34', variant: 'Normal', opId: 'd2' })).error.code).toBe('litefin_not_found');
    expect((await call('litefin.install', { device: devmode(), tag: 'v1.9.0', variant: 'Normal', opId: 'd3', channel: 'dev' })).error.code).toBe('litefin_not_found');
    const building = await call('litefin.install', { device: devmode(), tag: 'dev-b102-f00ba12', variant: 'Normal', opId: 'd4', channel: 'dev' });
    expect(building.error).toMatchObject({ code: 'litefin_not_found', message: expect.stringMatching(/dev build dev-b102-f00ba12 isn’t among the latest dev builds/) });
  });

  it('keeps only this project’s dev build files, named after the build’s commit', () => {
    const c = new LitefinClient('https://api.github.com/repos/MoazSalem/litefin-dev-builds', undefined, 'dev');
    const dl = (tag: string, name: string, repo = 'MoazSalem/litefin-dev-builds') => `https://github.com/${repo}/releases/download/${tag}/${name}`;
    const entries = c.parse([
      {
        tag_name: 'dev-b7-abc1234',
        published_at: '2026-01-01T00:00:00Z',
        body: '- **Commit Message:** fix: things\n- **Pushed by:** @someone',
        assets: [
          { name: 'Litefin-2.0.1-webOS-Normal-abc1234.ipk', size: 1, browser_download_url: dl('dev-b7-abc1234', 'Litefin-2.0.1-webOS-Normal-abc1234.ipk') },
          // Another build's file, another repository's, or no commit in the name: left out.
          { name: 'Litefin-2.0.1-webOS-Modern-fff0000.ipk', size: 1, browser_download_url: dl('dev-b7-abc1234', 'Litefin-2.0.1-webOS-Modern-fff0000.ipk') },
          { name: 'Litefin-2.0.1-webOS-Legacy-abc1234.ipk', size: 1, browser_download_url: dl('dev-b7-abc1234', 'Litefin-2.0.1-webOS-Legacy-abc1234.ipk', 'someone/else') },
          { name: 'Litefin-2.0.1-webOS-Ultra-Legacy.ipk', size: 1, browser_download_url: dl('dev-b7-abc1234', 'Litefin-2.0.1-webOS-Ultra-Legacy.ipk') },
        ],
      },
      // Not a dev build's tag.
      { tag_name: 'v2.0.1', published_at: '2026-01-02T00:00:00Z', assets: [{ name: 'Litefin-2.0.1-webOS-Normal.ipk', size: 1, browser_download_url: dl('v2.0.1', 'Litefin-2.0.1-webOS-Normal.ipk') }] },
      // A manual run without a commit hash.
      {
        tag_name: 'dev-b8-dev',
        published_at: '2026-01-01T00:00:00Z',
        assets: [{ name: 'Litefin-2.0.1-webOS-Normal-dev.ipk', size: 1, browser_download_url: dl('dev-b8-dev', 'Litefin-2.0.1-webOS-Normal-dev.ipk') }],
      },
    ]);
    expect(entries.map((e) => [e.release.tag, e.release.build, e.release.assets.map((a) => a.variant)])).toEqual([
      ['dev-b8-dev', { number: 8, commit: 'dev' }, ['Normal']],
      ['dev-b7-abc1234', { number: 7, commit: 'abc1234', message: 'fix: things' }, ['Normal']],
    ]);
  });
});

describe('litefin.installed', () => {
  it('tells which listed release or dev build is on the TV from its files’ packaged time — or that it’s none of them', async () => {
    // The Dev Mode TV got dev build #100 (Normal) above; the rooted one release v1.6.0 (Normal).
    expect((await call('litefin.installed', { device: devmode() })).result).toEqual({
      builtAt: (Date.parse('2026-11-12T12:57:00Z') / 1000 + 180 + 2) * 1000,
      match: { channel: 'dev', tag: 'dev-b100-0adcb34', variant: 'Normal' },
    });
    expect((await call('litefin.installed', { device: rooted() })).result).toMatchObject({ match: { channel: 'stable', tag: 'v1.6.0', variant: 'Normal' } });
    // Only the first bytes of the candidates' files were read (a ranged request), and only once.
    const heads = () => frames.filter((f) => f.event === 'cmd.log' && f.data.phase === 'start' && /\(first 8 KB\)/.test(f.data.command)).length;
    const before = heads();
    await call('litefin.installed', { device: devmode() });
    expect(heads()).toBe(before);

    // A build made elsewhere (compiled by hand): its time, and no match.
    const app = devTv.state.apps.find((a) => a.id === 'org.litefin.app')!;
    const real = app.builtAt;
    app.builtAt = Date.parse('2026-10-26T10:33:40Z') / 1000;
    try {
      expect((await call('litefin.installed', { device: devmode() })).result).toEqual({ builtAt: Date.parse('2026-10-26T10:33:40Z') });
    } finally {
      app.builtAt = real;
    }
    // No Litefin: nothing to say.
    const apps = devTv.state.apps;
    devTv.state.apps = apps.filter((a) => a.id !== 'org.litefin.app');
    try {
      expect((await call('litefin.installed', { device: devmode() })).result).toEqual({});
    } finally {
      devTv.state.apps = apps;
    }
  });

  it('reads a package’s build time from its first bytes only', () => {
    const ipk = fakeIpk('org.litefin.app', '2.0.0', 'Litefin', 50_000, { builtAt: 1794491844 });
    expect(ipkBuildTime(ipk.subarray(0, 8192))).toBe(1794491844);
    expect(ipkBuildTime(ipk.subarray(0, 200))).toBeNull(); // not far enough in
    expect(ipkBuildTime(Buffer.from('not an ipk'))).toBeNull();
  });
});
