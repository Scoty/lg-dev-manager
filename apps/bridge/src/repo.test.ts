import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeIconPng, startMockRepo, startMockTv, type MockRepo, type MockTv } from '@lgdm/mock-tv';
import type { DeviceTarget, OpProgress } from '@lgdm/protocol';
import { findInstallLocation, hbChannelConfig, installFromRepo, listApps } from './apps/apps.js';
import { isNonPublicAddress, normalizePackage, RepoClient, sniffImage } from './repo/repo.js';
import { RpcError } from './rpc/errors.js';
import { UploadBudget } from './rpc/uploads.js';
import { SshPool } from './ssh/pool.js';

const pool = new SshPool(1000);
let repo: MockRepo;
let devTv: MockTv; // Dev Mode, no Homebrew Channel
let rootTv: MockTv; // rooted, Homebrew Channel
let client: RepoClient;

const devmode = (tv: MockTv): DeviceTarget => ({
  host: tv.host,
  port: tv.sshPort,
  username: 'prisoner',
  auth: { kind: 'key', privateKey: tv.privateKey, passphrase: tv.passphrase },
});
const rooted = (tv: MockTv): DeviceTarget => ({ host: tv.host, port: tv.sshPort, username: 'root', auth: { kind: 'password', password: 'alpine' } });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof RpcError ? e.code : `non-rpc: ${(e as Error).message}`;
  }
  return 'no error';
}

const collect = () => {
  const events: Omit<OpProgress, 'opId'>[] = [];
  return { events, progress: (p: Omit<OpProgress, 'opId'>) => events.push(p) };
};

beforeAll(async () => {
  [repo, devTv, rootTv] = await Promise.all([
    startMockRepo(),
    startMockTv(),
    startMockTv({ username: 'root', password: 'alpine', hbchannel: true }),
  ]);
});
beforeEach(() => {
  client = new RepoClient(repo.url, new UploadBudget());
});
afterAll(async () => {
  pool.close();
  await Promise.all([repo.close(), devTv.close(), rootTv.close()]);
});

describe('repository index', () => {
  it('reads every page and keeps it for a while', async () => {
    const before = repo.requests.length;
    const { packages } = await client.list();
    expect(packages.map((p) => p.id)).toEqual(repo.apps.map((a) => a.id));
    expect(repo.requests.slice(before)).toEqual(['/api/apps.json', '/api/apps/2.json']);

    await client.list();
    expect(repo.requests.length).toBe(before + 2);
    await client.list({ refresh: true });
    expect(repo.requests.length).toBe(before + 4);
  });

  it('passes the useful fields through', async () => {
    const { packages } = await client.list();
    const app = packages.find((p) => p.id === 'com.example.repoapp')!;
    expect(app).toMatchObject({
      title: 'Repo Example',
      shortDescription: 'An app from the mock repository',
      featured: true,
      hasDescription: true,
      manifest: { id: 'com.example.repoapp', version: '1.2.0', ipkHash: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } },
    });
    expect(app.iconUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/apps\/icons\/com\.example\.repoapp\.png$/);
    expect(app.screenshots).toHaveLength(2);
    expect(packages.find((p) => p.id === 'com.example.future')!.requirements).toEqual({ webosRelease: '>=99.0' });
    expect(packages.find((p) => p.id === 'com.example.beta')!.manifestBeta?.version).toBe('1.1.0-beta.1');
  });

  it('drops unsafe or broken fields instead of the whole entry', () => {
    const page = 'https://repo.example/api/apps.json';
    const res = normalizePackage(
      {
        id: 'com.example.x',
        title: 'X',
        iconUri: 'javascript:alert(1)',
        detailIconUri: 'data:image/png;base64,AAAA',
        manifest: { version: '1.0.0', ipkUrl: 'file:///etc/passwd' },
        manifestBeta: { version: '1.1.0', ipkUrl: 'https://example.com/x.ipk', sourceUrl: 'javascript:x', ipkHash: { sha256: 'nope' } },
        screenshots: [{ url: 'https://example.com/a.png' }, { url: 'ftp://x' }],
        fullDescriptionUrl: 'apps/com.example.x/full_description.html',
        unknown: 1,
      },
      page,
    );
    expect(res?.package).toEqual({
      id: 'com.example.x',
      title: 'X',
      manifestBeta: { id: 'com.example.x', version: '1.1.0', ipkUrl: 'https://example.com/x.ipk' },
      screenshots: [{ url: 'https://example.com/a.png' }],
      hasDescription: true,
    });
    expect(res?.descriptionUrl).toBe('https://repo.example/api/apps/com.example.x/full_description.html');
    expect(normalizePackage({ id: 'bad id;rm', title: 'x' }, page)).toBeNull();
    expect(normalizePackage({ id: 'ok' }, page)).toBeNull();
  });

  it('fetches descriptions from the repository only', async () => {
    expect((await client.description('com.example.repoapp')).html).toContain('<strong>sample</strong>');
    expect(await code(client.description('com.example.nope'))).toBe('repo_not_found');
  });

  it('serves listed icons and screenshots only, from cache the second time', async () => {
    const { packages } = await client.list();
    const app = packages.find((p) => p.id === 'com.example.repoapp')!;
    const icon = await client.image(app.iconUri!);
    expect(icon.mime).toBe('image/png');
    expect(Buffer.from(icon.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const before = repo.requests.length;
    await client.image(app.iconUri!);
    await client.image(app.screenshots![0]!.url);
    expect(repo.requests.length).toBe(before + 1);
    expect(await code(client.image(`${repo.url}/apps.json`))).toBe('repo_not_found');
    expect(await code(client.image('https://example.com/anything.png'))).toBe('repo_not_found');
  });

  it('only fetches images from public addresses (or the repository itself), and only real images', async () => {
    const odd = await startMockRepo({
      apps: [
        { id: 'com.example.localicon', title: 'Local Icon', version: '1.0.0', iconOnLocalhost: true },
        { id: 'com.example.redirecticon', title: 'Redirect Icon', version: '1.0.0', iconRedirect: true },
        { id: 'com.example.htmlicon', title: 'HTML Icon', version: '1.0.0', iconBody: '<html><body>hi</body></html>' },
      ],
    });
    try {
      const c = new RepoClient(odd.url);
      const { packages } = await c.list();
      const icon = (id: string) => packages.find((p) => p.id === id)!.iconUri!;
      expect(await code(c.image(icon('com.example.localicon')))).toBe('repo_bad_response');
      expect(await code(c.image(icon('com.example.redirecticon')))).toBe('repo_bad_response');
      expect(await code(c.image(icon('com.example.htmlicon')))).toBe('repo_bad_response');
      // The refused requests never reached the local server.
      expect(odd.requests.filter((r) => r.startsWith('/apps/icons/com.example.localicon'))).toEqual([]);
    } finally {
      await odd.close();
    }
  });

  it('recognises images by their bytes and non-public addresses by range', () => {
    expect(sniffImage(makeIconPng([1, 2, 3], 4))).toBe('image/png');
    expect(sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('<html></html>'))).toBeNull();
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.1', '169.254.169.254', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
      expect(isNonPublicAddress(a), a).toBe(true);
    }
    for (const a of ['140.82.112.3', '185.199.108.133', '2606:50c0:8000::153']) expect(isNonPublicAddress(a), a).toBe(false);
  });

  it('allows images found in a description', async () => {
    const withImg = await startMockRepo({
      apps: [{ id: 'com.example.desc', title: 'Desc', version: '1.0.0', description: '<p>x</p><img alt="shot" src="../../../apps/com.example.desc/screenshot-1.png">' }],
    });
    try {
      const c = new RepoClient(withImg.url);
      // Not an icon or screenshot of the entry: only the description mentions it (as a relative URL).
      const url = `${withImg.url.replace(/\/api$/, '')}/apps/com.example.desc/screenshot-1.png`;
      await c.list();
      expect(await code(c.image(`${url}?x`))).toBe('repo_not_found');
      await c.description('com.example.desc');
      expect((await c.image(url)).mime).toBe('image/png');
    } finally {
      await withImg.close();
    }
  });

  it('reports an unreachable repository', async () => {
    const dead = new RepoClient('http://127.0.0.1:1/api');
    expect(await code(dead.list())).toBe('repo_unreachable');
  });

  it('refuses a redirect to another site', async () => {
    const other: Server = createServer((_req, res) => res.writeHead(302, { location: `${repo.url}/apps.json` }).end());
    await new Promise<void>((r) => other.listen(0, 'localhost', () => r()));
    try {
      const port = (other.address() as AddressInfo).port;
      expect(await code(new RepoClient(`http://localhost:${port}/api`).list())).toBe('repo_bad_response');
    } finally {
      other.close();
    }
  });
});

describe('Homebrew Channel config', () => {
  it('tells Dev Mode, rooted and missing apart', async () => {
    expect(await hbChannelConfig(pool, devmode(devTv))).toEqual({ installed: false, root: false });
    expect(await hbChannelConfig(pool, rooted(rootTv))).toEqual({ installed: true, root: true });
  });
});

describe('install location', () => {
  it('finds dev, store and system apps (Dev Mode via getAppLoadStatus, root via getAppInfo)', async () => {
    expect(await findInstallLocation(pool, devmode(devTv), 'com.example.hello')).toBe('developer');
    expect(await findInstallLocation(pool, devmode(devTv), 'com.example.storeapp')).toBe('cryptofs');
    expect(await findInstallLocation(pool, devmode(devTv), 'com.example.none')).toBeNull();
    expect(await findInstallLocation(pool, rooted(rootTv), 'com.limelight.webos')).toBe('developer');
    expect(await findInstallLocation(pool, rooted(rootTv), 'com.example.storeapp')).toBe('cryptofs');
    expect(await findInstallLocation(pool, rooted(rootTv), 'com.webos.app.browser')).toBe('system');
    expect(await findInstallLocation(pool, rooted(rootTv), 'com.example.none')).toBeNull();
  });
});

describe('install from the repository', () => {
  it('Dev Mode: the bridge downloads, checks and installs', async () => {
    const { events, progress } = collect();
    const res = await installFromRepo(pool, client, devmode(devTv), 'com.example.repoapp', 'stable', progress);
    expect(res).toEqual({ appId: 'com.example.repoapp', version: '1.2.0', via: 'devmode' });
    expect((await listApps(pool, devmode(devTv))).find((a) => a.id === 'com.example.repoapp')?.version).toBe('1.2.0');
    expect(events.some((e) => e.stage === 'upload' && e.text === 'Downloading the IPK…')).toBe(true);
    expect(events.some((e) => e.stage === 'install')).toBe(true);
    expect([...devTv.state.files.keys()].filter((f) => f.startsWith('/media/developer/temp/'))).toEqual([]);
  });

  it('updates an installed app', async () => {
    expect(devTv.state.apps.find((a) => a.id === 'youtube.leanback.v4')?.version).toBe('0.4.6');
    await installFromRepo(pool, client, devmode(devTv), 'youtube.leanback.v4', 'stable');
    expect(devTv.state.apps.find((a) => a.id === 'youtube.leanback.v4')?.version).toBe('0.5.0');
  });

  it('installs the beta channel, and says when there is none', async () => {
    expect(await installFromRepo(pool, client, devmode(devTv), 'com.example.beta', 'beta')).toMatchObject({ version: '1.1.0-beta.1' });
    expect(await code(installFromRepo(pool, client, devmode(devTv), 'com.example.repoapp', 'beta'))).toBe('repo_no_manifest');
  });

  it('rooted: Homebrew Channel downloads it on the TV', async () => {
    const before = repo.requests.length;
    const res = await installFromRepo(pool, client, rooted(rootTv), 'com.example.repoapp', 'stable');
    expect(res).toEqual({ appId: 'com.example.repoapp', version: '1.2.0', via: 'hbchannel' });
    expect(rootTv.state.apps.some((a) => a.id === 'com.example.repoapp')).toBe(true);
    // The TV fetched the IPK itself.
    expect(repo.requests.slice(before).some((p) => p.endsWith('.ipk'))).toBe(true);
  });

  it('refuses an id that belongs to a store app', async () => {
    expect(await code(installFromRepo(pool, client, devmode(devTv), 'com.example.storeapp', 'stable'))).toBe('app_conflict');
    expect(await code(installFromRepo(pool, client, rooted(rootTv), 'com.example.storeapp', 'stable'))).toBe('app_conflict');
  });

  it('rejects an IPK that fails its checksum — on the bridge, and after Homebrew Channel refuses it', async () => {
    expect(await code(installFromRepo(pool, client, devmode(devTv), 'com.example.badhash', 'stable'))).toBe('checksum_mismatch');
    expect(await code(installFromRepo(pool, client, rooted(rootTv), 'com.example.badhash', 'stable'))).toBe('checksum_mismatch');
    expect(devTv.state.apps.some((a) => a.id === 'com.example.badhash')).toBe(false);
    expect(rootTv.state.apps.some((a) => a.id === 'com.example.badhash')).toBe(false);
  });

  it('rooted: retries with the dev install when Homebrew Channel’s install step fails', async () => {
    const res = await installFromRepo(pool, client, rooted(rootTv), 'com.example.hbfail', 'stable');
    expect(res).toEqual({ appId: 'com.example.hbfail', version: '1.0.0', via: 'devmode' });
  });

  it('rooted: no retry when the TV is out of space', async () => {
    const full = await startMockRepo({ apps: [{ id: 'com.example.full', title: 'MOCK_NO_SPACE', version: '1.0.0' }] });
    try {
      const c = new RepoClient(full.url);
      expect(await code(installFromRepo(pool, c, rooted(rootTv), 'com.example.full', 'stable'))).toBe('insufficient_space');
      // Only Homebrew Channel (on the TV) fetched the IPK; the bridge didn't try again.
      expect(full.requests.filter((r) => r.endsWith('.ipk'))).toHaveLength(1);
    } finally {
      await full.close();
    }
  });

  it('counts downloads against the bridge’s memory budget by the bytes received', async () => {
    const budget = new UploadBudget(100);
    const small = new RepoClient(repo.url, budget);
    expect(await code(installFromRepo(pool, small, devmode(devTv), 'com.example.page2', 'stable'))).toBe('upload_too_large');
    expect(budget.inUse).toBe(0);
  });

  it('says when an app is not in the repository', async () => {
    expect(await code(installFromRepo(pool, client, devmode(devTv), 'com.example.unknown', 'stable'))).toBe('repo_not_found');
  });
});

describe('pinned connections', () => {
  it('refuse a host name that resolves to this computer at connect time', async () => {
    const { publicLookup } = await import('./repo/repo.js');
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => publicLookup('localhost', {}, (e) => r(e)));
    expect(err?.code).toBe('EPRIVATE');
  });
});
