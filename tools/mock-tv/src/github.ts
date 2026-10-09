import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeIpk } from './ipk.js';

/**
 * A fake GitHub for Litefin's releases (M8): `GET /repos/MoazSalem/litefin/releases` in GitHub's REST shape, and the
 * release files under `/MoazSalem/litefin/releases/download/<tag>/<file>`, which redirect to `/assets/…` like GitHub
 * redirects to its file host. IPKs are real, tiny packages (fakeIpk) with Litefin's app id.
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

export interface MockGithub {
  /** The API base to give the bridge (LGDM_LITEFIN_URL): `http://127.0.0.1:<port>/repos/MoazSalem/litefin`. */
  url: string;
  port: number;
  releases: MockLitefinRelease[];
  /** Paths requested, oldest first. */
  requests: string[];
  /** Make the release list answer like GitHub's rate limit. */
  rateLimited: boolean;
  close(): Promise<void>;
}

const versionOf = (tag: string) => tag.replace(/^v\.?/, '');

export async function startMockGithub(opts: { port?: number; host?: string; releases?: MockLitefinRelease[] } = {}): Promise<MockGithub> {
  const host = opts.host ?? '127.0.0.1';
  const releases = opts.releases ?? MOCK_LITEFIN_RELEASES;
  const requests: string[] = [];
  const files = new Map<string, Buffer>();
  const fileFor = (tag: string, variant: string) => {
    const key = `${tag}/${variant}`;
    let f = files.get(key);
    if (!f) {
      // A different payload per variant, so each build has its own checksum.
      f = fakeIpk(LITEFIN_MOCK_APP_ID, versionOf(tag), `Litefin ${variant}`, 20_000 + variant.length * 997);
      files.set(key, f);
    }
    return f;
  };
  let base = '';
  const state: MockGithub = { url: '', port: 0, releases, requests, rateLimited: false, close: async () => {} };

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
    if (path === '/repos/MoazSalem/litefin/releases') {
      if (state.rateLimited) {
        return res
          .writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) })
          .end(JSON.stringify({ message: 'API rate limit exceeded' }));
      }
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(listing()));
    }
    if ((m = path.match(/^\/MoazSalem\/litefin\/releases\/download\/([^/]+)\/([^/]+)$/))) {
      return res.writeHead(302, { location: `/assets/${m[1]}/${m[2]}` }).end();
    }
    if ((m = path.match(/^\/assets\/([^/]+)\/Litefin-[^/]+-webOS-([\w.-]+)\.ipk$/))) {
      const r = releases.find((x) => x.tag === decodeURIComponent(m![1]!));
      const variant = m[2]!;
      if (!r || !(r.variants ?? WEBOS_VARIANTS).includes(variant)) return res.writeHead(404).end('Not Found');
      const data = fileFor(r.tag, variant);
      return res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length }).end(data);
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, () => r()));
  const port = (server.address() as AddressInfo).port;
  base = `http://${host}:${port}`;
  state.url = `${base}/repos/MoazSalem/litefin`;
  state.port = port;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}
