import { LITEFIN_APP_ID, LITEFIN_DEV_BUILD_COUNT, LITEFIN_RELEASE_COUNT, LitefinErrorCodes, type LitefinAsset, type LitefinChannel, type LitefinRelease } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { bridgeUploadBudget, type UploadBudget } from '../rpc/uploads.js';
import { downloadIpk, readBody, readStart, safeGet, type HttpTrace, type Progress } from '../net/fetch.js';
import type { SshRunner } from '../ssh/pool.js';
import { ipkBuildTime } from './buildTime.js';

/**
 * Litefin's GitHub releases (M8). The Homebrew repository carries one Litefin build per version; its releases have one
 * IPK per webOS variant (`Litefin-<version>-webOS-<variant>.ipk`). The bridge reads the release list itself and only
 * ever downloads files from that list, from the project's own release-download path.
 *
 * The same client reads Litefin's dev builds (2.1.0, `channel: 'dev'`): the author's pipeline makes a release in
 * MoazSalem/litefin-dev-builds for every commit to Litefin's development branch, tagged `dev-b<build>-<commit>`, with
 * the same IPKs named `Litefin-<version>-webOS-<variant>-<commit>.ipk`. They all carry the version being worked on, so
 * the build number and commit are what tell them apart.
 */

const DEFAULT_LITEFIN_API = 'https://api.github.com/repos/MoazSalem/litefin';
const DEFAULT_LITEFIN_DEV_API = 'https://api.github.com/repos/MoazSalem/litefin-dev-builds';
/** `dev-b99-0ac5e76` → build 99, commit 0ac5e76 (`dev` for a manual run without one). */
const DEV_TAG = /^dev-b(\d{1,9})-([A-Za-z0-9]{1,40})$/;
/** The commit message line in a dev build's notes. */
const DEV_MESSAGE = /\*\*Commit Message:\*\*[ \t]*([^\r\n]*)/;
/** How much of a package is read to learn when it was built (its first tar header sits a few hundred bytes in). */
const HEAD_BYTES = 8192;
/** A listed package can be the installed one only if it was uploaded after it was built, and not ages after. */
const UPLOAD_AFTER_BUILD_MS = 14 * 86_400_000;
/** At most this many packages' first bytes are read per litefin.installed. */
const MAX_HEAD_READS = 30;
/** The installed Litefin's main page (the TV keeps its packaged time; appinfo.json gets rewritten on install). */
const INSTALLED_INDEX = `/media/developer/apps/usr/palm/applications/${LITEFIN_APP_ID}/index.html`;
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
  created_at?: unknown;
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
  body?: unknown;
}

/** A release plus where each of its files is (kept on the bridge; the client only sees tag + variant). */
interface Entry {
  release: LitefinRelease;
  urls: Map<string, string>;
  /** When each variant's file was uploaded (ms), from GitHub. */
  uploaded: Map<string, number>;
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
  /** When each package (by URL) was built, in seconds: release files never change, so this is kept. */
  private built = new Map<string, Promise<number | null>>();

  constructor(
    api?: string,
    private readonly budget: UploadBudget = bridgeUploadBudget,
    readonly channel: LitefinChannel = 'stable',
  ) {
    api ??= channel === 'dev' ? (process.env.LGDM_LITEFIN_DEV_URL ?? DEFAULT_LITEFIN_DEV_API) : (process.env.LGDM_LITEFIN_URL ?? DEFAULT_LITEFIN_API);
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
      const name = this.channel === 'dev' ? `Litefin dev build ${tag}` : `Litefin ${versionOfTag(tag)}`;
      throw new RpcError(
        LitefinErrorCodes.NotFound,
        listed
          ? `${name} has no ${variant.replace(/-/g, ' ')} build for webOS.`
          : `${name} isn’t among the latest ${this.channel === 'dev' ? 'dev builds' : 'releases'} any more. Refresh the list.`,
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

  /**
   * The listed builds packaged at `time` (seconds since 1970, from the installed files), with the variants whose file
   * says exactly that. Only packages uploaded after that moment (and within two weeks) are looked at, and of those only
   * the first 8 KB is read, once per file. A build compiled elsewhere (by hand, say) matches nothing.
   */
  async findBuilt(time: number, trace: HttpTrace = untraced): Promise<{ tag: string; variants: string[] }[]> {
    const c = await this.load(false, trace);
    const found: { tag: string; variants: string[] }[] = [];
    let reads = 0;
    for (const e of c.entries) {
      const near = [...e.urls].filter(([variant]) => {
        const up = e.uploaded.get(variant);
        return up === undefined || (up >= time * 1000 - 120_000 && up <= time * 1000 + UPLOAD_AFTER_BUILD_MS);
      });
      if (!near.length || reads + near.length > MAX_HEAD_READS) continue;
      reads += near.length;
      const times = await Promise.all(near.map(([, url]) => this.builtAt(url, trace)));
      const variants = near.filter((_, i) => times[i] === time).map(([v]) => v);
      if (variants.length) found.push({ tag: e.release.tag, variants });
    }
    return found;
  }

  /** When a listed package was built (seconds), from its first bytes; null when that can't be read. */
  private builtAt(url: string, trace: HttpTrace): Promise<number | null> {
    let p = this.built.get(url);
    if (!p) {
      p = trace(new URL(url).host, `GET ${url} (first ${HEAD_BYTES / 1024} KB)`, async () => {
        const res = await safeGet(url, 20_000, this.apiOrigin, undefined, false, HEAD_BYTES);
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`HTTP ${res.status}`);
        }
        return ipkBuildTime(await readStart(res, HEAD_BYTES));
      }).catch(() => {
        this.built.delete(url); // a failure isn't kept: asked again next time
        return null;
      });
      if (this.built.size > 500) this.built.delete(this.built.keys().next().value!);
      this.built.set(url, p);
    }
    return p;
  }

  /**
   * Published releases with webOS builds, newest first, the latest LITEFIN_RELEASE_COUNT — or, for dev builds, the
   * latest LITEFIN_DEV_BUILD_COUNT builds whose webOS IPKs are there (a build's release appears before its files).
   */
  parse(list: GhRelease[]): Entry[] {
    const dev = this.channel === 'dev';
    const out: Entry[] = [];
    for (const r of list) {
      const tag = str(r.tag_name);
      const publishedAt = str(r.published_at);
      if (!tag || !publishedAt || r.draft === true) continue;
      const devTag = dev ? DEV_TAG.exec(tag) : null;
      if (dev ? !devTag : r.prerelease === true || PREVIEW_TAG.test(tag)) continue;
      // A dev build's files end in its commit: Litefin-2.0.350-webOS-Normal-0ac5e76.ipk.
      const suffix = devTag ? `-${devTag[2]}.ipk` : '.ipk';
      const urls = new Map<string, string>();
      const uploaded = new Map<string, number>();
      const assets: LitefinAsset[] = [];
      for (const a of Array.isArray(r.assets) ? (r.assets as GhAsset[]) : []) {
        const name = str(a.name);
        const m = name?.endsWith(suffix) ? IPK_NAME.exec(`${name.slice(0, -suffix.length)}.ipk`) : null;
        const dl = str(a.browser_download_url);
        if (!name || !m || !dl || urls.has(m[2]!)) continue;
        // Only files from this project's own release downloads, at the place GitHub puts this release's files.
        if (dl !== `${this.downloadPrefix}${encodeURIComponent(tag)}/${encodeURIComponent(name)}` && dl !== `${this.downloadPrefix}${tag}/${name}`) continue;
        const digest = str(a.digest);
        const sha = digest && /^sha256:[0-9a-f]{64}$/i.test(digest) ? digest.slice(7).toLowerCase() : undefined;
        urls.set(m[2]!, dl);
        const up = Date.parse(str(a.created_at) ?? '');
        if (Number.isFinite(up)) uploaded.set(m[2]!, up);
        assets.push({ variant: m[2]!, name, size: typeof a.size === 'number' ? a.size : 0, ...(sha ? { sha256: sha } : {}) });
      }
      if (!assets.length) continue;
      // The version in the file names is the one the app reports once installed; the tag is only a fallback.
      const fromNames = IPK_NAME.exec(assets[0]!.name.slice(0, -suffix.length) + '.ipk')?.[1];
      const version = fromNames && /^\d[\w.]*$/.test(fromNames) ? fromNames : dev ? '' : versionOfTag(tag);
      if (!version) continue;
      const message = devTag ? DEV_MESSAGE.exec(str(r.body) ?? '')?.[1]?.trim().slice(0, 200) : undefined;
      out.push({
        release: {
          tag,
          version,
          title: str(r.name)?.trim().slice(0, 200) || tag,
          publishedAt,
          assets,
          ...(devTag ? { build: { number: Number(devTag[1]), commit: devTag[2]!, ...(message ? { message } : {}) } } : {}),
        },
        urls,
        uploaded,
      });
    }
    // Dev builds by build number (a rerun keeps its number); releases by date.
    out.sort((a, b) => (dev ? b.release.build!.number - a.release.build!.number : Date.parse(b.release.publishedAt) - Date.parse(a.release.publishedAt)));
    return out.slice(0, dev ? LITEFIN_DEV_BUILD_COUNT : LITEFIN_RELEASE_COUNT);
  }
}

/**
 * When the Litefin on this TV was packaged (seconds), from its index.html — null when Litefin isn't installed in the
 * developer apps folder (or its files can't be read).
 */
export async function installedLitefinTime(pool: SshRunner, device: Parameters<SshRunner['exec']>[0]): Promise<number | null> {
  const res = await pool.exec(device, `stat -c %Y ${INSTALLED_INDEX}`, { timeoutMs: 20_000 });
  const t = /^\s*(\d{6,12})\s*$/.exec(res.stdout);
  return res.exitCode === 0 && t ? Number(t[1]) : null;
}

function lookup(entries: Entry[], tag: string, variant: string) {
  const e = entries.find((x) => x.release.tag === tag);
  const asset = e?.release.assets.find((a) => a.variant === variant);
  const url = asset && e?.urls.get(variant);
  return e && asset && url ? { release: e.release, asset, url } : null;
}

export { LITEFIN_APP_ID };
