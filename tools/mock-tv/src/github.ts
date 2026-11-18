import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeIpk } from './ipk.js';

/**
 * A fake GitHub for Litefin's releases (M8): `GET /repos/MoazSalem/litefin/releases` in GitHub's REST shape, and the
 * release files under `/MoazSalem/litefin/releases/download/<tag>/<file>`, which redirect to `/assets/…` like GitHub
 * redirects to its file host. IPKs are real, tiny packages (fakeIpk) with Litefin's app id.
 *
 * Also Litefin's dev builds (2.1.0) at `/repos/MoazSalem/litefin-dev-builds/releases`: one release per commit, tagged
 * `dev-b<build>-<commit>`, all with the same version, files named `Litefin-<version>-webOS-<variant>-<commit>.ipk`.
 */

export const LITEFIN_MOCK_APP_ID = 'org.litefin.app';
const WEBOS_VARIANTS = ['Legacy', 'Modern', 'Normal', 'Ultra-Legacy-NoService', 'Ultra-Legacy'];

export interface MockLitefinRelease {
  tag: string;
  publishedAt: string;
  prerelease?: boolean;
  draft?: boolean;
  /** webOS variants shipped (default: all five). */
  variants?: string[];
  /** Variants whose served file doesn't match the listed digest. */
  badDigest?: string[];
  /** Variants listed without a digest (older GitHub releases). */
  noDigest?: string[];
}

/** Default releases: more than five published ones, a pre-release, a draft, a release without some builds. */
export const MOCK_LITEFIN_RELEASES: MockLitefinRelease[] = [
  { tag: 'v2.0.0-beta.1', publishedAt: '2026-10-05T10:00:00Z', prerelease: true },
  { tag: 'v2.0.0', publishedAt: '2026-10-08T10:00:00Z', draft: true },
  { tag: 'v1.9.0', publishedAt: '2026-10-01T10:00:00Z' },
  { tag: 'v1.8.0', publishedAt: '2026-09-15T10:00:00Z', badDigest: ['Legacy'] },
  { tag: 'v1.7.0', publishedAt: '2026-09-01T10:00:00Z', variants: ['Legacy', 'Normal', 'Ultra-Legacy'] },
  { tag: 'v1.6.0', publishedAt: '2026-08-15T10:00:00Z', noDigest: ['Normal'] },
  { tag: 'v.1.5.1', publishedAt: '2026-08-01T10:00:00Z' },
  { tag: 'v1.5.0', publishedAt: '2026-07-30T10:00:00Z' },
];

/** A dev build: its pipeline run and the commit it was built from. */
export interface MockLitefinDevBuild {
  build: number;
  commit: string;
  message: string;
  publishedAt: string;
  /** The release exists but its files aren't uploaded yet (a build still running). */
  building?: boolean;
}

/** All on the version being worked on; the newest still building; one tagged like something else (ignored). */
export const MOCK_LITEFIN_DEV_VERSION = '2.0.350';
export const MOCK_LITEFIN_DEV_BUILDS: MockLitefinDevBuild[] = [
  { build: 102, commit: 'f00ba12', message: 'feat: still building', publishedAt: '2026-11-12T15:00:00Z', building: true },
  { build: 101, commit: '0ac5e76', message: 'fix(webos): use the dvh1 hint <b>even</b> when canPlayType reports empty', publishedAt: '2026-11-12T13:54:00Z' },
  { build: 100, commit: '0adcb34', message: 'feat: faster home screen', publishedAt: '2026-11-12T12:57:00Z' },
  { build: 99, commit: '4485d43', message: 'fix: subtitles on webOS 4', publishedAt: '2026-11-12T11:06:00Z' },
  { build: 98, commit: '8406c0d', message: 'chore: translations', publishedAt: '2026-11-11T22:03:00Z' },
  { build: 97, commit: 'ebaf422', message: 'fix: resume position', publishedAt: '2026-11-11T11:01:00Z' },
  { build: 96, commit: '749cdc8', message: 'refactor: player', publishedAt: '2026-11-11T00:09:00Z' },
];

export interface MockGithub {
  /** The API base to give the bridge (LGDM_LITEFIN_URL): `http://127.0.0.1:<port>/repos/MoazSalem/litefin`. */
  url: string;
  /** The dev builds' API base (LGDM_LITEFIN_DEV_URL): `http://127.0.0.1:<port>/repos/MoazSalem/litefin-dev-builds`. */
  devUrl: string;
  devBuilds: MockLitefinDevBuild[];
  port: number;
  releases: MockLitefinRelease[];
  /** Paths requested, oldest first. */
  requests: string[];
  /** Make the release list answer like GitHub's rate limit. */
  rateLimited: boolean;
  close(): Promise<void>;
}

const versionOf = (tag: string) => tag.replace(/^v\.?/, '');

/** A release file, or the part a `Range: bytes=0-N` request asks for (206), as GitHub's file host does. */
function sendFile(req: IncomingMessage, res: ServerResponse, data: Buffer) {
  const range = /^bytes=0-(\d+)$/.exec(req.headers.range ?? '');
  if (range) {
    const part = data.subarray(0, Number(range[1]) + 1);
    return res
      .writeHead(206, { 'content-type': 'application/octet-stream', 'content-length': part.length, 'content-range': `bytes 0-${part.length - 1}/${data.length}` })
      .end(part);
  }
  return res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length }).end(data);
}

export async function startMockGithub(
  opts: { port?: number; host?: string; releases?: MockLitefinRelease[]; devBuilds?: MockLitefinDevBuild[] } = {},
): Promise<MockGithub> {
  const host = opts.host ?? '127.0.0.1';
  const releases = opts.releases ?? MOCK_LITEFIN_RELEASES;
  const devBuilds = opts.devBuilds ?? MOCK_LITEFIN_DEV_BUILDS;
  const devTag = (b: MockLitefinDevBuild) => `dev-b${b.build}-${b.commit}`;
  const requests: string[] = [];
  const files = new Map<string, Buffer>();
  /**
   * When a build was packaged (seconds): a dev build 3 minutes after its release was made, a release 10 minutes before
   * it was published; each variant a second apart, like the real pipeline's parallel steps.
   */
  const builtAt = (tag: string, variant: string) => {
    const dev = devBuilds.find((b) => devTag(b) === tag);
    const at = Date.parse(dev ? dev.publishedAt : (releases.find((r) => r.tag === tag)?.publishedAt ?? '2026-01-01T00:00:00Z')) / 1000;
    return at + (dev ? 180 : -600) + WEBOS_VARIANTS.indexOf(variant);
  };
  /** When a build's files were uploaded (ISO): 5 minutes after a dev build's release was made; a release's when published. */
  const uploadedAt = (publishedAt: string, dev: boolean) => new Date(Date.parse(publishedAt) + (dev ? 300_000 : 0)).toISOString();
  const fileFor = (tag: string, variant: string) => {
    const key = `${tag}/${variant}`;
    let f = files.get(key);
    if (!f) {
      // A different payload per variant (and dev build), so each build has its own checksum.
      const dev = tag.startsWith('dev-b');
      f = fakeIpk(LITEFIN_MOCK_APP_ID, dev ? MOCK_LITEFIN_DEV_VERSION : versionOf(tag), `Litefin ${variant}`, 20_000 + variant.length * 997 + (dev ? Number(/^dev-b(\d+)/.exec(tag)![1]) * 7 : 0), {
        builtAt: builtAt(tag, variant),
      });
      files.set(key, f);
    }
    return f;
  };
  let base = '';
  const state: MockGithub = { url: '', devUrl: '', devBuilds, port: 0, releases, requests, rateLimited: false, close: async () => {} };

  const devListing = () =>
    devBuilds.map((b, i) => {
      const tag = devTag(b);
      const dl = (name: string) => `${base}/MoazSalem/litefin-dev-builds/releases/download/${tag}/${name}`;
      const ipks = b.building
        ? []
        : WEBOS_VARIANTS.map((variant) => {
            const name = `Litefin-${MOCK_LITEFIN_DEV_VERSION}-webOS-${variant}-${b.commit}.ipk`;
            const data = fileFor(tag, variant);
            return {
              name,
              size: data.length,
              digest: `sha256:${createHash('sha256').update(data).digest('hex')}`,
              created_at: uploadedAt(b.publishedAt, true),
              browser_download_url: dl(name),
            };
          });
      return {
        id: 5000 + i,
        tag_name: tag,
        name: `Litefin Dev Build #${b.build} (${b.commit})`,
        draft: false,
        prerelease: false,
        published_at: b.publishedAt,
        body: [
          '## Automated Litefin Development Build',
          '',
          `- **Source Commit:** [\`${b.commit}\`](https://github.com/MoazSalem/litefin/commit/${b.commit})`,
          `- **Commit Message:** ${b.message}`,
          '- **Pushed by:** @MoazSalem',
        ].join('\n'),
        assets: [
          ...(b.building ? [] : [{ name: `Litefin-${MOCK_LITEFIN_DEV_VERSION}-Tizen-Normal-${b.commit}.wgt`, size: 5000, browser_download_url: dl('x.wgt') }]),
          ...ipks,
        ],
      };
    });

  const listing = () =>
    releases.map((r, i) => {
      const variants = r.variants ?? WEBOS_VARIANTS;
      const v = versionOf(r.tag);
      const dl = (name: string) => `${base}/MoazSalem/litefin/releases/download/${r.tag}/${name}`;
      const ipks = variants.map((variant) => {
        const name = `Litefin-${v}-webOS-${variant}.ipk`;
        const data = fileFor(r.tag, variant);
        const sha = createHash('sha256').update(r.badDigest?.includes(variant) ? Buffer.from('something else') : data).digest('hex');
        return {
          name,
          size: data.length,
          content_type: 'application/octet-stream',
          ...(r.noDigest?.includes(variant) ? {} : { digest: `sha256:${sha}` }),
          created_at: uploadedAt(r.publishedAt, false),
          browser_download_url: dl(name),
        };
      });
      return {
        id: 1000 + i,
        tag_name: r.tag,
        name: `Litefin ${r.tag}`,
        draft: !!r.draft,
        prerelease: !!r.prerelease,
        published_at: r.publishedAt,
        html_url: `https://github.com/MoazSalem/litefin/releases/tag/${r.tag}`,
        assets: [
          // Tizen builds and the Homebrew manifest are in every real release; they must be ignored.
          { name: `Litefin-${v}-Tizen-Normal.wgt`, size: 5000, browser_download_url: dl(`Litefin-${v}-Tizen-Normal.wgt`) },
          { name: 'manifest.json', size: 474, browser_download_url: dl('manifest.json') },
          // A webOS IPK served from somewhere else: must be ignored too.
          { name: `Litefin-${v}-webOS-Elsewhere.ipk`, size: 5000, browser_download_url: `https://example.com/Litefin-${v}-webOS-Elsewhere.ipk` },
          ...ipks,
        ],
      };
    });

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    requests.push(req.url ?? path);
    let m: RegExpMatchArray | null;
    if (path === '/repos/MoazSalem/litefin-dev-builds/releases') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(devListing()));
    }
    if (path === '/repos/MoazSalem/litefin/releases') {
      if (state.rateLimited) {
        return res
          .writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) })
          .end(JSON.stringify({ message: 'API rate limit exceeded' }));
      }
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(listing()));
    }
    if ((m = path.match(/^\/MoazSalem\/litefin(?:-dev-builds)?\/releases\/download\/([^/]+)\/([^/]+)$/))) {
      return res.writeHead(302, { location: `/assets/${m[1]}/${m[2]}` }).end();
    }
    if ((m = path.match(/^\/assets\/(dev-b\d+-([0-9a-f]+))\/Litefin-[^/]+-webOS-([\w.-]+)-[0-9a-f]+\.ipk$/))) {
      const b = devBuilds.find((x) => devTag(x) === m![1]);
      const variant = m[3]!;
      if (!b || b.building || !WEBOS_VARIANTS.includes(variant)) return res.writeHead(404).end('Not Found');
      return sendFile(req, res, fileFor(m[1]!, variant));
    }
    if ((m = path.match(/^\/assets\/([^/]+)\/Litefin-[^/]+-webOS-([\w.-]+)\.ipk$/))) {
      const r = releases.find((x) => x.tag === decodeURIComponent(m![1]!));
      const variant = m[2]!;
      if (!r || !(r.variants ?? WEBOS_VARIANTS).includes(variant)) return res.writeHead(404).end('Not Found');
      return sendFile(req, res, fileFor(r.tag, variant));
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, () => r()));
  const port = (server.address() as AddressInfo).port;
  base = `http://${host}:${port}`;
  state.url = `${base}/repos/MoazSalem/litefin`;
  state.devUrl = `${base}/repos/MoazSalem/litefin-dev-builds`;
  state.port = port;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}
