import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeIpk } from './ipk.js';
import { makeIconPng } from './state.js';

/**
 * A fake webOS Homebrew repository (repo.webosbrew.org) for tests and UI development. Serves the same paths and
 * shapes as the real one: `/api/apps.json` (+ `/api/apps/<page>.json`), `/api/apps/<id>/full_description.html`,
 * icons, and the IPKs themselves (real, tiny IPKs from fakeIpk).
 */
export interface MockRepoApp {
  id: string;
  title: string;
  version: string;
  short?: string;
  rootRequired?: boolean | 'optional';
  webosRelease?: string;
  deviceSoC?: string[];
  beta?: string;
  /** Serve an IPK whose sha256 doesn't match the manifest. */
  badHash?: boolean;
  /** Serve a 404 for the IPK. */
  missingIpk?: boolean;
  description?: string;
  screenshots?: number;
  featured?: boolean;
  padBytes?: number;
  /** Icon URL served as a redirect to http://localhost:<port>/… (a different, local origin). */
  iconRedirect?: boolean;
  /** Icon URL on http://localhost:<port> instead of the repository's own host. */
  iconOnLocalhost?: boolean;
  /** Serve this instead of a PNG for the icon (e.g. HTML). */
  iconBody?: string;
}

/** The default catalogue: covers the states the UI has to show. Ids that the mock TV has installed are noted. */
export const MOCK_REPO_APPS: MockRepoApp[] = [
  {
    id: 'org.webosbrew.hbchannel',
    title: 'Homebrew Channel',
    version: '0.7.3',
    short: 'webOS Homebrew installer',
    featured: true,
    description: '<h2>Homebrew Channel</h2><p>Install apps from the <a href="https://www.webosbrew.org/">webOS Homebrew</a> repository.</p>',
  },
  {
    id: 'com.example.repoapp',
    title: 'Repo Example',
    version: '1.2.0',
    short: 'An app from the mock repository',
    featured: true,
    screenshots: 2,
    padBytes: 150_000,
    description:
      '<h2>About</h2><p>A <strong>sample</strong> app. See <a href="https://example.com/repoapp">the project</a>.</p>' +
      '<ul><li>One</li><li>Two with <code>code</code></li></ul>' +
      '<script>window.__pwned = true</script><img src="x" onerror="window.__pwned = true">' +
      '<p><a href="javascript:window.__pwned=true">bad link</a></p>',
  },
  // Installed at 0.4.6 on the mock TV → update available.
  { id: 'youtube.leanback.v4', title: 'YouTube AdFree', version: '0.5.0', short: 'YouTube TV without ads' },
  // Installed at the same version → nothing to update.
  { id: 'com.limelight.webos', title: 'Moonlight', version: '1.2.1', short: 'Game streaming client' },
  { id: 'com.example.rootonly', title: 'Root Only Tool', version: '2.0.0', short: 'Needs a rooted TV', rootRequired: true },
  { id: 'com.example.future', title: 'Future App', version: '1.0.0', short: 'Needs a newer webOS', webosRelease: '>=99.0' },
  // Installed from the "LG Content Store" on the mock TV → conflict.
  { id: 'com.example.storeapp', title: 'Store App', version: '3.0.0', short: 'Also sold in the LG store' },
  { id: 'com.example.badhash', title: 'Broken Download', version: '1.0.0', short: 'Its IPK fails the checksum', badHash: true },
  { id: 'com.example.beta', title: 'Beta Channel App', version: '1.0.0', short: 'Has a beta', beta: '1.1.0-beta.1' },
  // Homebrew Channel's install step fails for it; the dev install works.
  { id: 'com.example.hbfail', title: 'Picky Installer App', version: '1.0.0', short: 'Homebrew Channel can’t install it' },
  { id: 'com.example.page2', title: 'Second Page App', version: '0.1.0', short: 'Listed on page 2' },
];

export interface MockRepo {
  /** The API base, like https://repo.webosbrew.org/api */
  url: string;
  port: number;
  apps: MockRepoApp[];
  /** Paths requested, newest last. */
  requests: string[];
  close(): Promise<void>;
}

export async function startMockRepo(opts: { port?: number; host?: string; apps?: MockRepoApp[]; pageSize?: number } = {}): Promise<MockRepo> {
  const apps = opts.apps ?? MOCK_REPO_APPS;
  const pageSize = opts.pageSize ?? 9;
  const host = opts.host ?? '127.0.0.1';
  const requests: string[] = [];
  const ipks = new Map<string, Buffer>();
  const ipkFor = (app: MockRepoApp, version: string) => {
    const key = `${app.id}@${version}`;
    let data = ipks.get(key);
    if (!data) {
      data = fakeIpk(app.id, version, app.title, app.padBytes ?? 0);
      ipks.set(key, data);
    }
    return data;
  };
  let base = '';
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  const manifest = (app: MockRepoApp, version: string, channel: 'stable' | 'beta') => {
    const data = ipkFor(app, version);
    return {
      id: app.id,
      version,
      type: 'web',
      title: app.title,
      appDescription: app.short ?? app.title,
      iconUri: `${base.replace(/\/api$/, '')}/apps/icons/${app.id}.png`,
      sourceUrl: `https://example.com/${app.id}`,
      ...(app.rootRequired !== undefined ? { rootRequired: app.rootRequired } : {}),
      ipkUrl: `${base.replace(/\/api$/, '')}/apps/${app.id}/releases/${channel}-${version}.ipk`,
      ipkHash: { sha256: app.badHash ? '0'.repeat(64) : sha(data) },
      ipkSize: data.length,
    };
  };

  const item = (app: MockRepoApp) => {
    const root = base.replace(/\/api$/, '');
    const iconUri = app.iconRedirect
      ? `${root}/apps/icons/redirect/${app.id}.png`
      : app.iconOnLocalhost
        ? `${root.replace('127.0.0.1', 'localhost')}/apps/icons/${app.id}.png`
        : `${root}/apps/icons/${app.id}.png`;
    return {
      id: app.id,
      title: app.title,
      iconUri,
      manifestUrl: `https://example.com/${app.id}/manifest.json`,
      manifest: manifest(app, app.version, 'stable'),
      ...(app.beta ? { manifestBeta: manifest(app, app.beta, 'beta') } : {}),
      pool: 'main',
      shortDescription: app.short,
      ...(app.featured ? { featured: true } : {}),
      fullDescriptionUrl: `apps/${app.id}/full_description.html`,
      ...(app.webosRelease || app.deviceSoC
        ? { requirements: { ...(app.webosRelease ? { webosRelease: app.webosRelease } : {}), ...(app.deviceSoC ? { deviceSoC: app.deviceSoC } : {}) } }
        : {}),
      ...(app.screenshots
        ? {
            screenshots: Array.from({ length: app.screenshots }, (_, i) => ({
              url: `${root}/apps/${app.id}/screenshot-${i + 1}.png`,
              caption: `Screenshot ${i + 1}`,
              width: 1280,
              height: 720,
            })),
          }
        : {}),
    };
  };

  const maxPage = Math.max(1, Math.ceil(apps.length / pageSize));
  const page = (n: number) => ({
    paging: {
      page: n,
      count: Math.min(pageSize, apps.length - (n - 1) * pageSize),
      maxPage,
      itemsTotal: apps.length,
      prevUrl: n > 1 ? (n === 2 ? '/api/apps.json' : `/api/apps/${n - 1}.json`) : null,
      nextUrl: n < maxPage ? `/api/apps/${n + 1}.json` : null,
    },
    packages: apps.slice((n - 1) * pageSize, n * pageSize).map(item),
  });

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    requests.push(path);
    const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const notFound = () => res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
    let m: RegExpMatchArray | null;
    if (path === '/api/apps.json') return json(page(1));
    if ((m = path.match(/^\/api\/apps\/(\d+)\.json$/))) {
      const n = Number(m[1]);
      return n >= 1 && n <= maxPage ? json(page(n)) : notFound();
    }
    if ((m = path.match(/^\/api\/apps\/([\w.-]+)\/full_description\.html$/))) {
      const app = apps.find((a) => a.id === m![1]);
      if (!app) return notFound();
      return res.writeHead(200, { 'content-type': 'text/html' }).end(app.description ?? `<p>${app.short ?? app.title}</p>`);
    }
    if ((m = path.match(/^\/apps\/icons\/redirect\/([\w.-]+)\.png$/))) {
      return res.writeHead(302, { location: `http://localhost:${port}/apps/icons/${m[1]}.png` }).end();
    }
    if ((m = path.match(/^\/apps\/icons\/([\w.-]+)\.png$/)) || (m = path.match(/^\/apps\/([\w.-]+)\/screenshot-\d+\.png$/))) {
      const i = apps.findIndex((a) => a.id === m![1]);
      if (i < 0) return notFound();
      const body = apps[i]!.iconBody;
      if (body !== undefined) return res.writeHead(200, { 'content-type': 'image/png' }).end(body);
      const rgb: [number, number, number] = [[220, 60, 90], [60, 130, 220], [40, 170, 120], [230, 150, 40]][i % 4] as [number, number, number];
      return res.writeHead(200, { 'content-type': 'image/png' }).end(makeIconPng(rgb, 96));
    }
    if ((m = path.match(/^\/apps\/([\w.-]+)\/releases\/(stable|beta)-(.+)\.ipk$/))) {
      const app = apps.find((a) => a.id === m![1]);
      if (!app || app.missingIpk) return notFound();
      const data = ipkFor(app, m[3]!);
      return res.writeHead(200, { 'content-type': 'application/vnd.debian.binary-package', 'content-length': data.length }).end(data);
    }
    notFound();
  });
  let port = 0;
  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, () => r()));
  port = (server.address() as AddressInfo).port;
  base = `http://${host}:${port}/api`;
  return {
    url: base,
    port,
    apps,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
