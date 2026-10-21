import {
  DEFAULT_REPO_URL,
  RepoErrorCodes,
  RepoManifest,
  RepoPackage,
  RepoScreenshot,
  WebUrl,
} from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { bridgeUploadBudget, type UploadBudget } from '../rpc/uploads.js';
import { downloadIpk, readBody, safeGet, untraced, type HttpTrace, type Progress } from '../net/fetch.js';
import { sniffImage } from '../net/image.js';

/**
 * The webOS Homebrew repository, fetched by the bridge (port of AppsRepoService,
 * dev-manager-desktop src/app/core/services/apps-repo.service.ts). Only ever talks to the configured
 * repository for its JSON and descriptions; IPKs come from the URLs in the manifests it fetched itself.
 * Nothing about devices is involved, so the index is kept in memory for a few minutes.
 */

const CACHE_MS = 5 * 60_000;
const JSON_MAX_BYTES = 16 * 1024 * 1024;
const HTML_MAX_BYTES = 512 * 1024;
const MAX_PAGES = 50;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_CACHE_BYTES = 48 * 1024 * 1024;
/** Apps read from one custom repository at most (a huge index could otherwise fill the bridge's memory and the page). */
const MAX_CUSTOM_PACKAGES = 2000;
/** Pages read from a custom repository's index at most (the official one: MAX_PAGES). */
const MAX_CUSTOM_PAGES = 10;
/** How long reading a custom repository's index (pages and manifests) may take before what's in is used. */
const CUSTOM_INDEX_MS = 45_000;
/** Image cache per custom repository (up to 8 are kept: registry.ts). */
const CUSTOM_IMAGE_CACHE_BYTES = 8 * 1024 * 1024;
/** Separate manifest files (`manifestUrl` entries): how many are fetched per index load, how many at once, how big. */
const MAX_MANIFEST_FETCHES = 200;
const MANIFEST_FETCHES_AT_ONCE = 6;
const MANIFEST_MAX_BYTES = 256 * 1024;

interface Index {
  at: number;
  packages: RepoPackage[];
  /** Icon and screenshot URLs the index lists — the only images `image()` fetches. */
  images: Set<string>;
  /** Description URLs by app id, resolved against the page they came from. */
  descriptions: Map<string, string>;
}

interface RepoClientOptions {
  /**
   * A repository the user added (not repo.webosbrew.org): its own server isn't trusted either — every request, the
   * index included, must go to a public address (no loopback, LAN, link-local), and messages name it by host.
   */
  custom?: boolean;
  /** Test rig only (LGDM_TEST_ALLOW_LOCAL_REPOS): trust a custom repository's own origin like the official one. */
  trustOwnOrigin?: boolean;
}

export class RepoClient {
  /** The first page of the index (`…/apps.json`). */
  readonly indexUrl: string;
  private readonly origin: string;
  /** The repository's own origin, when it may be fetched without the public-address checks. */
  private readonly trusted?: string;
  /** A repository the user added: untrusted, and its apps are installed with extra checks (installFromRepo). */
  readonly custom: boolean;
  /**
   * Everything a custom repository points the bridge at (manifests, icons, IPKs, every redirect hop) must be https, so
   * nobody on the network path can swap what gets installed. Off only in the test rig, whose servers are http.
   */
  private readonly httpsOnly: boolean;
  /** "the Homebrew repository" or "the repository at host", for messages. */
  readonly name: string;
  private index?: Index;
  private loading?: Promise<Index>;
  /** Recently fetched images, oldest first (a Map keeps insertion order). */
  private imageCache = new Map<string, { mime: string; base64: string; bytes: number }>();
  private imageCacheBytes = 0;
  private imageLoads = new Map<string, Promise<{ mime: string; base64: string }>>();

  /** `source`: an API base (…/api, pages at …/apps.json) or the address of an index file (…/apps.json). */
  constructor(
    source = process.env.LGDM_REPO_URL ?? DEFAULT_REPO_URL,
    private readonly budget: UploadBudget = bridgeUploadBudget,
    opts: RepoClientOptions = {},
  ) {
    const src = source.replace(/\/+$/, '');
    // A custom repository is named by the exact address of its index (repo.check found it): any path, kept as is.
    this.indexUrl = opts.custom ? new URL(source).href : /\.json$/i.test(new URL(src).pathname) ? src : `${src}/apps.json`;
    this.origin = new URL(this.indexUrl).origin;
    this.trusted = !opts.custom || opts.trustOwnOrigin ? this.origin : undefined;
    this.custom = !!opts.custom;
    this.httpsOnly = !!opts.custom && !opts.trustOwnOrigin;
    this.name = opts.custom ? `the repository at ${this.host}` : 'the Homebrew repository';
  }

  get host() {
    return new URL(this.indexUrl).host;
  }

  /** Page `n` of the index: `apps.json`, then `apps/2.json` … (only for indexes named apps.json). */
  private pageUrl(n: number): string | null {
    if (n === 1) return this.indexUrl;
    return /\/apps\.json$/i.test(this.indexUrl) ? this.indexUrl.replace(/\/apps\.json$/i, `/apps/${n}.json`) : null;
  }

  private get Name() {
    return this.name.charAt(0).toUpperCase() + this.name.slice(1);
  }

  /** All apps, from cache when fresh. */
  async list(opts: { refresh?: boolean; trace?: HttpTrace } = {}): Promise<{ packages: RepoPackage[]; fetchedAt: number }> {
    const idx = await this.load(opts.refresh ?? false, opts.trace ?? untraced);
    return { packages: idx.packages, fetchedAt: idx.at };
  }

  /** One app, from an index no older than the cache time. */
  async get(id: string, trace: HttpTrace = untraced): Promise<RepoPackage> {
    let idx = await this.load(false, trace);
    let pkg = idx.packages.find((p) => p.id === id);
    if (!pkg && Date.now() - idx.at > 10_000) {
      idx = await this.load(true, trace);
      pkg = idx.packages.find((p) => p.id === id);
    }
    if (!pkg) throw new RpcError(RepoErrorCodes.NotFound, `${id} isn't in ${this.name}.`);
    return pkg;
  }

  /** An icon or screenshot the index lists, as base64. Cached in memory. */
  async image(url: string, trace: HttpTrace = untraced): Promise<{ mime: string; base64: string }> {
    const idx = await this.load(false, trace);
    if (!idx.images.has(url)) throw new RpcError(RepoErrorCodes.NotFound, `That image isn’t part of ${this.name}.`);
    const hit = this.imageCache.get(url);
    if (hit) {
      this.imageCache.delete(url);
      this.imageCache.set(url, hit);
      return { mime: hit.mime, base64: hit.base64 };
    }
    let p = this.imageLoads.get(url);
    if (!p) {
      p = trace(new URL(url).host, `GET ${url}`, () => this.fetchImage(url)).finally(() => this.imageLoads.delete(url));
      this.imageLoads.set(url, p);
    }
    return p;
  }

  private async fetchImage(url: string): Promise<{ mime: string; base64: string }> {
    let res: Response;
    try {
      res = await safeGet(url, 30_000, this.trusted, undefined, this.httpsOnly);
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError(RepoErrorCodes.Unreachable, 'Couldn’t load the image.', `${url}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new RpcError(RepoErrorCodes.BadResponse, `The image server answered HTTP ${res.status}.`, url);
    }
    const data = await readBody(res, IMAGE_MAX_BYTES);
    const mime = sniffImage(data);
    if (!mime) throw new RpcError(RepoErrorCodes.BadResponse, 'That isn’t an image.', url);
    const out = { mime, base64: data.toString('base64') };
    this.imageCache.set(url, { ...out, bytes: out.base64.length });
    this.imageCacheBytes += out.base64.length;
    for (const [k, v] of this.imageCache) {
      if (this.imageCacheBytes <= (this.custom ? CUSTOM_IMAGE_CACHE_BYTES : IMAGE_CACHE_BYTES)) break;
      this.imageCache.delete(k);
      this.imageCacheBytes -= v.bytes;
    }
    return out;
  }

  async description(id: string, trace: HttpTrace = untraced): Promise<{ html: string | null; baseUrl?: string }> {
    await this.get(id, trace);
    const url = this.index?.descriptions.get(id);
    if (!url) return { html: null };
    const html = (await trace(this.host, `GET ${url}`, () => this.fetchOk(url, HTML_MAX_BYTES))).toString('utf8');
    // Images in the description load through `image()` too, so they join the allowed list.
    if (this.index) {
      for (const src of imgSources(html)) {
        try {
          const abs = new URL(src.replace(/&amp;/g, '&'), url);
          if (abs.protocol === 'https:' || abs.protocol === 'http:') this.index.images.add(abs.toString());
        } catch {
          /* not a URL */
        }
      }
    }
    return { html, baseUrl: url };
  }

  /**
   * Download a manifest's IPK into memory (counted against the bridge's upload budget), checking its size and
   * sha256. Returns the data and a function that releases the budget.
   */
  download(manifest: RepoManifest, progress?: Progress, trace: HttpTrace = untraced): Promise<{ data: Buffer; sha256: string; done: () => void }> {
    return downloadIpk(
      { url: manifest.ipkUrl, id: manifest.id, size: manifest.ipkSize, sha256: manifest.ipkHash?.sha256, budget: this.budget, trustedOrigin: this.trusted, httpsOnly: this.httpsOnly, checksumFrom: 'the repository’s' },
      progress,
      trace,
    );
  }

  private load(refresh: boolean, trace: HttpTrace): Promise<Index> {
    if (!refresh && this.index && Date.now() - this.index.at < CACHE_MS) return Promise.resolve(this.index);
    this.loading ??= this.fetchIndex(trace)
      .then((idx) => (this.index = idx))
      .finally(() => (this.loading = undefined));
    return this.loading;
  }

  /** apps.json, then apps/2.json … up to paging.maxPage (allApps$ in apps-repo.service.ts). */
  private async fetchIndex(trace: HttpTrace): Promise<Index> {
    const packages: RepoPackage[] = [];
    const descriptions = new Map<string, string>();
    const images = new Set<string>();
    const seen = new Set<string>();
    const manifestUrls = new Map<RepoPackage, string>();
    let maxPage = 1;
    // A custom repository gets a time limit for the whole read, and fewer pages and apps: it can't keep the bridge
    // busy (or its memory full) for long.
    const deadline = this.custom ? Date.now() + CUSTOM_INDEX_MS : Infinity;
    for (let page = 1; page <= Math.min(maxPage, this.custom ? MAX_CUSTOM_PAGES : MAX_PAGES); page++) {
      const url = this.pageUrl(page);
      if (!url) break;
      if (page > 1 && (Date.now() > deadline || (this.custom && packages.length >= MAX_CUSTOM_PACKAGES))) break;
      const body = await trace(this.host, `GET ${url}`, () => this.fetchOk(url, JSON_MAX_BYTES));
      let json: { paging?: { maxPage?: unknown }; packages?: unknown };
      try {
        json = JSON.parse(jsonText(body));
      } catch {
        throw new RpcError(RepoErrorCodes.BadResponse, `${this.Name} sent something that isn’t JSON.`, url);
      }
      if (!json || !Array.isArray(json.packages)) throw new RpcError(RepoErrorCodes.BadResponse, `${this.Name}’s app list looks wrong.`, url);
      if (page === 1 && typeof json.paging?.maxPage === 'number') maxPage = json.paging.maxPage;
      for (const raw of json.packages) {
        if (this.custom && packages.length >= MAX_CUSTOM_PACKAGES) break;
        const pkg = normalizePackage(raw, url);
        if (!pkg || seen.has(pkg.package.id)) continue;
        seen.add(pkg.package.id);
        packages.push(pkg.package);
        if (pkg.manifestUrl) manifestUrls.set(pkg.package, pkg.manifestUrl);
        for (const u of [pkg.package.iconUri, pkg.package.detailIconUri, ...(pkg.package.screenshots ?? []).map((s) => s.url)]) if (u) images.add(u);
        if (pkg.descriptionUrl && new URL(pkg.descriptionUrl).origin === this.origin) descriptions.set(pkg.package.id, pkg.descriptionUrl);
        else pkg.package.hasDescription = false;
      }
    }
    await this.fillManifests(manifestUrls, trace, deadline);
    return { at: Date.now(), packages, descriptions, images };
  }

  /**
   * Entries that give a `manifestUrl` instead of an embedded manifest (e.g. one in the app's GitHub releases): fetch
   * those manifests, a few at a time, so the page knows the version and can install. A manifest that can't be fetched
   * or doesn't match its entry leaves that app without one (shown, not installable). Same public-address rules as
   * icons and IPKs for anything outside the trusted repository.
   */
  private async fillManifests(todo: Map<RepoPackage, string>, trace: HttpTrace, deadline = Infinity) {
    const queue = [...todo].slice(0, MAX_MANIFEST_FETCHES);
    const worker = async () => {
      for (let next = queue.shift(); next && Date.now() < deadline; next = queue.shift()) {
        const [pkg, manifestUrl] = next;
        try {
          const res = await trace(new URL(manifestUrl).host, `GET ${manifestUrl}`, () => safeGet(manifestUrl, 30_000, this.trusted, undefined, this.httpsOnly));
          if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            continue;
          }
          const manifest = parseManifest(JSON.parse(jsonText(await readBody(res, MANIFEST_MAX_BYTES))), pkg.id, manifestUrl);
          if (manifest && manifest.id === pkg.id) {
            pkg.manifest = manifest;
            if (!pkg.shortDescription && manifest.appDescription) pkg.shortDescription = plainText(manifest.appDescription).slice(0, 500) || undefined;
          }
        } catch {
          /* unreachable, not JSON, too big: no manifest for this app */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MANIFEST_FETCHES_AT_ONCE, queue.length) }, worker));
  }

  private async request(url: string, timeoutMs: number): Promise<Response> {
    return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { accept: '*/*' } });
  }

  /**
   * GET from the repository itself: refuses redirects to other sites. A custom repository's server goes through the
   * public-address checks too (safeGet), so an added repository can't point the bridge at this computer or the LAN.
   */
  private async fetchOk(url: string, maxBytes: number): Promise<Buffer> {
    let res: Response;
    try {
      res = this.trusted ? await this.request(url, 30_000) : await safeGet(url, 30_000, undefined, this.origin, this.httpsOnly);
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError(RepoErrorCodes.Unreachable, `Couldn’t reach ${this.name}. Is this computer online?`, `${url}: ${(e as Error).message}`);
    }
    if (new URL(res.url || url).origin !== this.origin) {
      await res.body?.cancel().catch(() => {});
      throw new RpcError(RepoErrorCodes.BadResponse, `${this.Name} redirected to another site.`, res.url);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new RpcError(RepoErrorCodes.BadResponse, `${this.Name} answered HTTP ${res.status}.`, url);
    }
    return readBody(res, maxBytes);
  }
}

/** Most images a description may add to the allowed list. */
const MAX_DESCRIPTION_IMAGES = 100;

/**
 * The `src` of each <img> in a description, in linear time: each tag is found with indexOf and only it (at most 4 KB)
 * is searched. One regex over the whole page was quadratic on `<img <img <img…` and could block the bridge for seconds.
 */
export function imgSources(html: string): string[] {
  const out: string[] = [];
  const find = /<img/gi;
  let nextGt = -1;
  let tags = 0;
  for (let hit = find.exec(html); hit && out.length < MAX_DESCRIPTION_IMAGES && ++tags <= 5000; hit = find.exec(html)) {
    const at = hit.index;
    if (nextGt < at) nextGt = html.indexOf('>', at);
    if (nextGt < 0) break; // no tag ends after this: none of the rest can either
    const tag = html.slice(at, Math.min(nextGt, at + 4096));
    const m = /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(tag);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** A JSON file's text: UTF-8, without the byte-order mark some editors (and pastebins) put in front. */
function jsonText(body: Buffer): string {
  return body.toString('utf8').replace(/^﻿/, '');
}

const sha256Of = (v: unknown) => {
  const sum = v && typeof v === 'object' ? (v as { sha256?: unknown }).sha256 : undefined;
  return typeof sum === 'string' && /^[0-9a-f]{64}$/i.test(sum) ? { sha256: sum.toLowerCase() } : undefined;
};
const str = (v: unknown, max = 4096) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
/** An http(s) URL, relative ones resolved against `base` (Homebrew Channel's resolveURL, frontend/baseurl.js). */
const url = (v: unknown, base?: string) => {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  let abs: string;
  try {
    abs = base ? new URL(v.trim(), base).toString() : v.trim();
  } catch {
    return undefined;
  }
  const r = WebUrl.safeParse(abs);
  return r.success ? r.data : undefined;
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** Some repositories put HTML in shortDescription (Homebrew Channel renders it); the cards show it as plain text. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A package manifest (embedded in the index, or fetched from `manifestUrl`) → the clean shape. A relative `ipkUrl` is
 * resolved against `base` — the manifest's own address, or the index page — as Homebrew Channel does.
 */
function parseManifest(m: unknown, id: string, base: string): RepoManifest | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  const parsed = RepoManifest.safeParse({
    id: str(o.id, 255) ?? id,
    version: str(o.version, 64),
    type: str(o.type, 32),
    title: str(o.title, 200),
    appDescription: str(o.appDescription, 1000),
    sourceUrl: url(o.sourceUrl),
    rootRequired: o.rootRequired === true || o.rootRequired === false || o.rootRequired === 'optional' ? o.rootRequired : undefined,
    ipkUrl: url(o.ipkUrl, base),
    ipkHash: sha256Of(o.ipkHash),
    ipkSize: typeof o.ipkSize === 'number' ? o.ipkSize : undefined,
  });
  return parsed.success ? stripUndefined(parsed.data) : undefined;
}

/**
 * One repository entry → the clean shape the UI gets. Invalid optional parts are dropped rather than failing the
 * whole entry; entries without an id or title are skipped.
 */
export function normalizePackage(
  raw: unknown,
  pageUrl: string,
): { package: RepoPackage; descriptionUrl?: string; manifestUrl?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 255);
  const title = str(r.title, 200);
  if (!id || !/^[\w.-]+$/.test(id) || !title) return null;

  // Where the manifest lives when it isn't embedded (Homebrew Channel fetches it: DetailsPanel.refresh). Relative
  // IPK addresses in an embedded manifest resolve against it too, else against the index page.
  const manifestUrl = url(r.manifestUrl, pageUrl);
  const manifest = (m: unknown) => parseManifest(m, id, manifestUrl ?? pageUrl);
  // Many third-party entries leave shortDescription out; the manifest's appDescription is the next best line.
  const rawManifest = r.manifest && typeof r.manifest === 'object' ? (r.manifest as Record<string, unknown>) : undefined;
  const short = str(r.shortDescription, 2000) ?? str(rawManifest?.appDescription, 2000);

  const reqs = r.requirements && typeof r.requirements === 'object' ? (r.requirements as Record<string, unknown>) : undefined;
  const requirements = reqs
    ? stripUndefined({
        webosRelease: str(reqs.webosRelease, 100),
        deviceSoC: Array.isArray(reqs.deviceSoC) ? reqs.deviceSoC.filter((s): s is string => typeof s === 'string').slice(0, 50) : undefined,
      })
    : undefined;
  const screenshots = Array.isArray(r.screenshots)
    ? r.screenshots.flatMap((s) => {
        const shot = s && typeof s === 'object' ? { ...(s as Record<string, unknown>), url: url((s as Record<string, unknown>).url, pageUrl) } : s;
        const p = RepoScreenshot.safeParse(shot);
        return p.success ? [stripUndefined(p.data)] : [];
      }).slice(0, 12)
    : undefined;

  let descriptionUrl: string | undefined;
  const desc = str(r.fullDescriptionUrl, 2048);
  if (desc) {
    try {
      descriptionUrl = new URL(desc, pageUrl).toString();
    } catch {
      /* ignore */
    }
  }

  const pkg = RepoPackage.safeParse(
    stripUndefined({
      id,
      title,
      iconUri: url(r.iconUri, pageUrl),
      detailIconUri: url(r.detailIconUri, pageUrl),
      shortDescription: short ? plainText(short).slice(0, 500) || undefined : undefined,
      featured: r.featured === true ? true : undefined,
      manifest: manifest(r.manifest),
      manifestBeta: manifest(r.manifestBeta),
      requirements: requirements && Object.keys(requirements).length ? requirements : undefined,
      screenshots: screenshots?.length ? screenshots : undefined,
      hasDescription: !!descriptionUrl,
    }),
  );
  if (!pkg.success) return null;
  // Only when it isn't embedded: the index then fetches it (fillManifests).
  return { package: pkg.data, descriptionUrl, ...(pkg.data.manifest ? {} : manifestUrl ? { manifestUrl } : {}) };
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
