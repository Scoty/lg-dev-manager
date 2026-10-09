import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import {
  AppsErrorCodes,
  DEFAULT_REPO_URL,
  MAX_UPLOAD_BYTES,
  RepoErrorCodes,
  RepoManifest,
  RepoPackage,
  RepoScreenshot,
  WebUrl,
} from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { bridgeUploadBudget, type UploadBudget } from '../rpc/uploads.js';

/**
 * The webOS Homebrew repository, fetched by the bridge (port of AppsRepoService,
 * dev-manager-desktop src/app/core/services/apps-repo.service.ts). Only ever talks to the configured
 * repository for its JSON and descriptions; IPKs come from the URLs in the manifests it fetched itself.
 * Nothing about devices is involved, so the index is kept in memory for a few minutes.
 */

/** Logs a network step in the client's console (kind `http`). */
export type HttpTrace = <T>(target: string, command: string, fn: () => Promise<T>) => Promise<T>;
const untraced: HttpTrace = (_t, _c, fn) => fn();

const CACHE_MS = 5 * 60_000;
const JSON_MAX_BYTES = 16 * 1024 * 1024;
const HTML_MAX_BYTES = 512 * 1024;
const MAX_PAGES = 50;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Image type from the bytes themselves (servers like raw.githubusercontent.com send text/plain). */
export function sniffImage(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = data.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Loopback, private, link-local and other non-public ranges: never fetched for URLs that came from app entries. */
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) NON_PUBLIC.addSubnet(net, prefix, 'ipv6');

export function isNonPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return NON_PUBLIC.check(mapped[1]!, 'ipv4');
  const family = isIP(address);
  return family === 4 ? NON_PUBLIC.check(address, 'ipv4') : family === 6 ? NON_PUBLIC.check(address, 'ipv6') : true;
}

interface Index {
  at: number;
  packages: RepoPackage[];
  /** Icon and screenshot URLs the index lists — the only images `image()` fetches. */
  images: Set<string>;
  /** Description URLs by app id, resolved against the page they came from. */
  descriptions: Map<string, string>;
}

export type Progress = (p: { stage: 'upload'; percent?: number; text: string }) => void;

export class RepoClient {
  readonly base: string;
  private readonly origin: string;
  private index?: Index;
  private loading?: Promise<Index>;
  /** Recently fetched images, oldest first (a Map keeps insertion order). */
  private imageCache = new Map<string, { mime: string; base64: string; bytes: number }>();
  private imageCacheBytes = 0;
  private imageLoads = new Map<string, Promise<{ mime: string; base64: string }>>();

  constructor(base = process.env.LGDM_REPO_URL ?? DEFAULT_REPO_URL, private readonly budget: UploadBudget = bridgeUploadBudget) {
    this.base = base.replace(/\/+$/, '');
    this.origin = new URL(this.base).origin;
  }

  get host() {
    return new URL(this.base).host;
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
    if (!pkg) throw new RpcError(RepoErrorCodes.NotFound, `${id} isn't in the Homebrew repository.`);
    return pkg;
  }

  /** An icon or screenshot the index lists, as base64. Cached in memory. */
  async image(url: string, trace: HttpTrace = untraced): Promise<{ mime: string; base64: string }> {
    const idx = await this.load(false, trace);
    if (!idx.images.has(url)) throw new RpcError(RepoErrorCodes.NotFound, 'That image isn’t part of the Homebrew repository.');
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
      res = await this.safeGet(url, 30_000);
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
      if (this.imageCacheBytes <= IMAGE_CACHE_BYTES) break;
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
      for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
        try {
          const abs = new URL(m[1]!.replace(/&amp;/g, '&'), url);
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
      { url: manifest.ipkUrl, id: manifest.id, size: manifest.ipkSize, sha256: manifest.ipkHash?.sha256, budget: this.budget, trustedOrigin: this.origin, checksumFrom: 'the repository’s' },
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
    let maxPage = 1;
    for (let page = 1; page <= Math.min(maxPage, MAX_PAGES); page++) {
      const url = page > 1 ? `${this.base}/apps/${page}.json` : `${this.base}/apps.json`;
      const body = await trace(this.host, `GET ${url}`, () => this.fetchOk(url, JSON_MAX_BYTES));
      let json: { paging?: { maxPage?: unknown }; packages?: unknown };
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        throw new RpcError(RepoErrorCodes.BadResponse, 'The Homebrew repository sent something that isn’t JSON.', url);
      }
      if (!Array.isArray(json.packages)) throw new RpcError(RepoErrorCodes.BadResponse, 'The Homebrew repository’s app list looks wrong.', url);
      if (page === 1 && typeof json.paging?.maxPage === 'number') maxPage = json.paging.maxPage;
      for (const raw of json.packages) {
        const pkg = normalizePackage(raw, url);
        if (!pkg || seen.has(pkg.package.id)) continue;
        seen.add(pkg.package.id);
        packages.push(pkg.package);
        for (const u of [pkg.package.iconUri, pkg.package.detailIconUri, ...(pkg.package.screenshots ?? []).map((s) => s.url)]) if (u) images.add(u);
        if (pkg.descriptionUrl && new URL(pkg.descriptionUrl).origin === this.origin) descriptions.set(pkg.package.id, pkg.descriptionUrl);
        else pkg.package.hasDescription = false;
      }
    }
    return { at: Date.now(), packages, descriptions, images };
  }

  private async request(url: string, timeoutMs: number): Promise<Response> {
    return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { accept: '*/*' } });
  }

  private safeGet(href: string, timeoutMs: number): Promise<Response> {
    return safeGet(href, timeoutMs, this.origin);
  }

  /** GET from the repository itself: refuses redirects to other sites. */
  private async fetchOk(url: string, maxBytes: number): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.request(url, 30_000);
    } catch (e) {
      throw new RpcError(RepoErrorCodes.Unreachable, 'Couldn’t reach the Homebrew repository. Is this computer online?', `${url}: ${(e as Error).message}`);
    }
    if (new URL(res.url || url).origin !== this.origin) {
      throw new RpcError(RepoErrorCodes.BadResponse, 'The Homebrew repository redirected to another site.', res.url);
    }
    if (!res.ok) throw new RpcError(RepoErrorCodes.BadResponse, `The Homebrew repository answered HTTP ${res.status}.`, url);
    return readBody(res, maxBytes);
  }
}

/**
 * GET a URL that came from an app entry or a release list (icons, screenshots, IPKs): http(s) only, redirects followed
 * by hand, and every hop outside `trustedOrigin` (the configured source itself) must be a public address — no
 * loopback, LAN or link-local.
 */
export async function safeGet(href: string, timeoutMs: number, trustedOrigin?: string): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = new URL(href);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RpcError(RepoErrorCodes.BadResponse, 'Only http(s) links can be fetched.', url.href);
    if (url.origin !== trustedOrigin) await assertPublicHost(url);
    const res = await fetch(url, { redirect: 'manual', signal, headers: { accept: '*/*' } });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    await res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new RpcError(RepoErrorCodes.BadResponse, 'Too many redirects.', href);
    url = new URL(location, url);
  }
}

/**
 * Download an IPK into memory (counted against the bridge's upload budget), checking its size and, when known, its
 * sha256. Returns the data and a function that releases the budget.
 */
export async function downloadIpk(
  o: { url: string; id: string; size?: number; sha256?: string; budget: UploadBudget; trustedOrigin?: string; checksumFrom: string },
  progress?: Progress,
  trace: HttpTrace = untraced,
): Promise<{ data: Buffer; sha256: string; done: () => void }> {
  const url = new URL(o.url);
  const expected = o.sha256?.toLowerCase();
  // The budget grows with the bytes actually received, so a missing or wrong content-length can't dodge it.
  const frees: (() => void)[] = [];
  const done = () => frees.splice(0).forEach((f) => f());
  const data = await trace(url.host, `GET ${url.href}`, async () => {
    try {
      const res = await safeGet(url.href, 300_000, o.trustedOrigin).catch((e: Error) => {
        if (e instanceof RpcError) throw e;
        throw new RpcError(RepoErrorCodes.DownloadFailed, `Couldn't download ${o.id}.`, e.message);
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new RpcError(RepoErrorCodes.DownloadFailed, `Couldn't download ${o.id} (HTTP ${res.status}).`, url.href);
      }
      // content-length is the compressed size when the response is encoded: only trust it for plain bodies.
      const encoded = !!res.headers.get('content-encoding') && res.headers.get('content-encoding') !== 'identity';
      const length = (!encoded && Number(res.headers.get('content-length'))) || o.size || 0;
      if (length > MAX_UPLOAD_BYTES) {
        await res.body.cancel().catch(() => {});
        throw tooBig(o.id);
      }
      return await readBody(res, MAX_UPLOAD_BYTES, (got, chunk) => {
        frees.push(o.budget.reserve(chunk));
        progress?.({
          stage: 'upload',
          percent: length ? Math.min(100, Math.floor((got / length) * 100)) : undefined,
          text: 'Downloading the IPK…',
        });
      }).catch((e: Error) => {
        if (e instanceof RpcError) throw e;
        throw new RpcError(RepoErrorCodes.DownloadFailed, `Couldn't download ${o.id}.`, e.message);
      });
    } catch (e) {
      done();
      throw e;
    }
  });
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (expected && sha256 !== expected) {
    done();
    throw new RpcError(
      AppsErrorCodes.ChecksumMismatch,
      `The downloaded IPK for ${o.id} doesn't match ${o.checksumFrom} checksum.`,
      `expected ${expected}, got ${sha256}`,
    );
  }
  return { data, sha256, done };
}

async function assertPublicHost(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new RpcError(RepoErrorCodes.Unreachable, `Couldn’t find ${host}.`, url.href);
  if (addresses.some(isNonPublicAddress)) {
    throw new RpcError(RepoErrorCodes.BadResponse, 'Refusing to fetch from a local or private network address.', url.href);
  }
}

const tooBig = (id: string) => new RpcError(AppsErrorCodes.UploadTooLarge, `${id} is larger than the bridge can download (${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`);

/** Read a body up to `maxBytes`. `onChunk` may throw (e.g. the budget is full); the download is then cancelled. */
export async function readBody(res: Response, maxBytes: number, onChunk?: (got: number, chunk: number) => void): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new RpcError(AppsErrorCodes.UploadTooLarge, `The download is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    }
    try {
      onChunk?.(got, value.byteLength);
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const sha256Of = (v: unknown) => {
  const sum = v && typeof v === 'object' ? (v as { sha256?: unknown }).sha256 : undefined;
  return typeof sum === 'string' && /^[0-9a-f]{64}$/i.test(sum) ? { sha256: sum.toLowerCase() } : undefined;
};
const str = (v: unknown, max = 4096) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const url = (v: unknown) => {
  const r = WebUrl.safeParse(v);
  return r.success ? r.data : undefined;
};

/**
 * One repository entry → the clean shape the UI gets. Invalid optional parts are dropped rather than failing the
 * whole entry; entries without an id or title are skipped.
 */
export function normalizePackage(raw: unknown, pageUrl: string): { package: RepoPackage; descriptionUrl?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 255);
  const title = str(r.title, 200);
  if (!id || !/^[\w.-]+$/.test(id) || !title) return null;

  const manifest = (m: unknown) => {
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
      ipkUrl: o.ipkUrl,
      ipkHash: sha256Of(o.ipkHash),
      ipkSize: typeof o.ipkSize === 'number' ? o.ipkSize : undefined,
    });
    return parsed.success ? stripUndefined(parsed.data) : undefined;
  };

  const reqs = r.requirements && typeof r.requirements === 'object' ? (r.requirements as Record<string, unknown>) : undefined;
  const requirements = reqs
    ? stripUndefined({
        webosRelease: str(reqs.webosRelease, 100),
        deviceSoC: Array.isArray(reqs.deviceSoC) ? reqs.deviceSoC.filter((s): s is string => typeof s === 'string').slice(0, 50) : undefined,
      })
    : undefined;
  const screenshots = Array.isArray(r.screenshots)
    ? r.screenshots.flatMap((s) => {
        const p = RepoScreenshot.safeParse(s);
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
      iconUri: url(r.iconUri),
      detailIconUri: url(r.detailIconUri),
      shortDescription: str(r.shortDescription, 500),
      featured: r.featured === true ? true : undefined,
      manifest: manifest(r.manifest),
      manifestBeta: manifest(r.manifestBeta),
      requirements: requirements && Object.keys(requirements).length ? requirements : undefined,
      screenshots: screenshots?.length ? screenshots : undefined,
      hasDescription: !!descriptionUrl,
    }),
  );
  return pkg.success ? { package: pkg.data, descriptionUrl } : null;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
