import { LITEFIN_APP_ID, LITEFIN_RELEASE_COUNT, LitefinErrorCodes, type LitefinAsset, type LitefinRelease } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { bridgeUploadBudget, type UploadBudget } from '../rpc/uploads.js';
import { downloadIpk, readBody, type HttpTrace, type Progress } from '../repo/repo.js';

/**
 * Litefin's GitHub releases (M8). The Homebrew repository carries one Litefin build per version; its releases have one
 * IPK per webOS variant (`Litefin-<version>-webOS-<variant>.ipk`). The bridge reads the release list itself and only
 * ever downloads files from that list, from the project's own release-download path.
 */

export const DEFAULT_LITEFIN_API = 'https://api.github.com/repos/MoazSalem/litefin';
const CACHE_MS = 10 * 60_000;
/** An install of something not in the list fetches it again at most this often (GitHub allows 60 calls an hour). */
const MISS_REFRESH_MS = 60_000;
const LIST_MAX_BYTES = 8 * 1024 * 1024;
/** `Litefin-1.9.0-webOS-Ultra-Legacy-NoService.ipk` → version 1.9.0, variant Ultra-Legacy-NoService. */
const IPK_NAME = /^Litefin-(.+?)-webOS-([A-Za-z0-9][\w.-]*)\.ipk$/;
/** Tags of preview builds that aren't flagged as pre-releases. */
const PREVIEW_TAG = /[-.+_](alpha|beta|rc|pre|preview|dev|nightly)/i;

const untraced: HttpTrace = (_t, _c, fn) => fn();

interface GhAsset {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
}
interface GhRelease {
  tag_name?: unknown;
  name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

/** A release plus where each of its files is (kept on the bridge; the client only sees tag + variant). */
interface Entry {
  release: LitefinRelease;
  urls: Map<string, string>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** "v1.9.0" → "1.9.0" (also the odd "v.0.45.1"). */
export const versionOfTag = (tag: string) => tag.replace(/^v\.?/i, '');

export class LitefinClient {
  readonly api: string;
  /** Files may only come from `<downloadPrefix><tag>/<file>` (GitHub then redirects to its file host). */
  readonly downloadPrefix: string;
  private readonly apiOrigin: string;
  private cache?: { at: number; entries: Entry[] };
  private loading?: Promise<{ at: number; entries: Entry[] }>;

  constructor(api = process.env.LGDM_LITEFIN_URL ?? DEFAULT_LITEFIN_API, private readonly budget: UploadBudget = bridgeUploadBudget) {
    this.api = api.replace(/\/+$/, '');
    const u = new URL(this.api);
    const m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (!m) throw new Error(`Not a GitHub repository API URL: ${api}`);
    this.apiOrigin = u.origin;
    // api.github.com/repos/<owner>/<repo> → github.com/<owner>/<repo>/releases/download/ (a test server serves both).
    const site = u.hostname === 'api.github.com' ? 'https://github.com' : u.origin;
    this.downloadPrefix = `${site}/${m[1]}/${m[2]}/releases/download/`;
  }

  async list(opts: { refresh?: boolean; trace?: HttpTrace } = {}): Promise<{ releases: LitefinRelease[]; fetchedAt: number; stale?: string }> {
    try {
      const c = await this.load(opts.refresh ?? false, opts.trace ?? untraced);
      return { releases: c.entries.map((e) => e.release), fetchedAt: c.at };
    } catch (e) {
      // Offline or rate-limited: the list fetched earlier is still useful (its files may still download).
      if (!this.cache) throw e;
      return { releases: this.cache.entries.map((x) => x.release), fetchedAt: this.cache.at, stale: (e as Error).message };
    }
  }

  /** Download one build of a listed release. */
  async download(tag: string, variant: string, progress?: Progress, trace: HttpTrace = untraced) {
    const { release, asset, url } = await this.find(tag, variant, trace);
    return {
      release,
      asset,
      url,
      fetch: () =>
        downloadIpk(
          { url, id: asset.name, size: asset.size, sha256: asset.sha256, budget: this.budget, trustedOrigin: this.apiOrigin, checksumFrom: 'GitHub’s' },
          progress,
          trace,
        ),
    };
  }

  /** A listed release's build, from a list no older than the cache time (fetched again once if it isn't there). */
  async find(tag: string, variant: string, trace: HttpTrace = untraced): Promise<{ release: LitefinRelease; asset: LitefinAsset; url: string }> {
    let c = await this.load(false, trace);
    let hit = lookup(c.entries, tag, variant);
    if (!hit && Date.now() - c.at > MISS_REFRESH_MS) {
      c = await this.load(true, trace);
      hit = lookup(c.entries, tag, variant);
    }
    if (!hit) {
      const listed = c.entries.some((e) => e.release.tag === tag);
      throw new RpcError(
        LitefinErrorCodes.NotFound,
        listed
          ? `Litefin ${versionOfTag(tag)} has no ${variant.replace(/-/g, ' ')} build for webOS.`
          : `Litefin ${versionOfTag(tag)} isn’t among the latest releases any more. Refresh the list.`,
      );
    }
    return hit;
  }

  private load(refresh: boolean, trace: HttpTrace) {
    if (!refresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return Promise.resolve(this.cache);
    this.loading ??= this.fetchList(trace)
      .then((c) => (this.cache = c))
      .finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async fetchList(trace: HttpTrace): Promise<{ at: number; entries: Entry[] }> {
    // One page of 100: enough to find 5 published releases even after a run of pre-releases.
    const url = `${this.api}/releases?per_page=100`;
    const body = await trace(new URL(url).host, `GET ${url}`, async () => {
      let res: Response;
      try {
        res = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
          headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'lg-dev-manager-bridge' },
        });
      } catch (e) {
        throw new RpcError(LitefinErrorCodes.Unreachable, 'Couldn’t reach GitHub. Is this computer online?', `${url}: ${(e as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        throw new RpcError(LitefinErrorCodes.BadResponse, 'GitHub says the Litefin repository has moved; the bridge needs an update.', `${url} → ${res.headers.get('location') ?? '?'}`);
      }
      // Primary limit (x-ratelimit-remaining: 0) and secondary limits (retry-after, or 429).
      const limited =
        res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')));
      if (limited) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const after = Number(res.headers.get('retry-after'));
        const at = reset ? new Date(reset * 1000) : after ? new Date(Date.now() + after * 1000) : null;
        const when = at ? ` Try again after ${at.toLocaleTimeString()}.` : ' Try again in a while.';
        await res.body?.cancel().catch(() => {});
        throw new RpcError(LitefinErrorCodes.RateLimited, `GitHub’s limit for this network was reached (60 requests an hour).${when}`);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new RpcError(LitefinErrorCodes.BadResponse, `GitHub answered HTTP ${res.status}.`, url);
      }
      const data = await readBody(res, LIST_MAX_BYTES).catch(() => {
        throw new RpcError(LitefinErrorCodes.BadResponse, 'GitHub’s answer is unexpectedly large.', url);
      });
      return data.toString('utf8');
    });
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new RpcError(LitefinErrorCodes.BadResponse, 'GitHub’s answer isn’t valid JSON.', url);
    }
    if (!Array.isArray(json)) throw new RpcError(LitefinErrorCodes.BadResponse, 'GitHub’s answer isn’t a list of releases.', url);
    return { at: Date.now(), entries: this.parse(json as GhRelease[]) };
  }

  /** Published releases with webOS builds, newest first, the latest LITEFIN_RELEASE_COUNT. */
  parse(list: GhRelease[]): Entry[] {
    const out: Entry[] = [];
    for (const r of list) {
      const tag = str(r.tag_name);
      const publishedAt = str(r.published_at);
      if (!tag || !publishedAt || r.draft === true || r.prerelease === true || PREVIEW_TAG.test(tag)) continue;
      const urls = new Map<string, string>();
      const assets: LitefinAsset[] = [];
      for (const a of Array.isArray(r.assets) ? (r.assets as GhAsset[]) : []) {
        const name = str(a.name);
        const m = name ? IPK_NAME.exec(name) : null;
        const dl = str(a.browser_download_url);
        if (!name || !m || !dl || urls.has(m[2]!)) continue;
        // Only files from this project's own release downloads, at the place GitHub puts this release's files.
        if (dl !== `${this.downloadPrefix}${encodeURIComponent(tag)}/${encodeURIComponent(name)}` && dl !== `${this.downloadPrefix}${tag}/${name}`) continue;
        const digest = str(a.digest);
        const sha = digest && /^sha256:[0-9a-f]{64}$/i.test(digest) ? digest.slice(7).toLowerCase() : undefined;
        urls.set(m[2]!, dl);
        assets.push({ variant: m[2]!, name, size: typeof a.size === 'number' ? a.size : 0, ...(sha ? { sha256: sha } : {}) });
      }
      if (!assets.length) continue;
      // The version in the file names is the one the app reports once installed; the tag is only a fallback.
      const fromNames = IPK_NAME.exec(assets[0]!.name)?.[1];
      out.push({
        release: { tag, version: fromNames && /^\d[\w.]*$/.test(fromNames) ? fromNames : versionOfTag(tag), title: str(r.name)?.trim() || tag, publishedAt, assets },
        urls,
      });
    }
    out.sort((a, b) => Date.parse(b.release.publishedAt) - Date.parse(a.release.publishedAt));
    return out.slice(0, LITEFIN_RELEASE_COUNT);
  }
}

function lookup(entries: Entry[], tag: string, variant: string) {
  const e = entries.find((x) => x.release.tag === tag);
  const asset = e?.release.assets.find((a) => a.variant === variant);
  const url = asset && e?.urls.get(variant);
  return e && asset && url ? { release: e.release, asset, url } : null;
}

export { LITEFIN_APP_ID };
