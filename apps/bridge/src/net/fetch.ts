import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { AppsErrorCodes, MAX_UPLOAD_BYTES, RepoErrorCodes } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import type { UploadBudget } from '../rpc/uploads.js';

/**
 * The bridge's guarded web requests, for URLs that come from outside — app entries, custom repositories, release
 * lists: http(s) only (or https only), redirects followed by hand, every hop on a public address (never this computer,
 * the LAN or link-local, checked on the connection itself), and bodies read up to a limit.
 */

/** Logs a network step in the client's console (kind `http`). */
export type HttpTrace = <T>(target: string, command: string, fn: () => Promise<T>) => Promise<T>;
export const untraced: HttpTrace = (_t, _c, fn) => fn();

const MAX_REDIRECTS = 5;

export type Progress = (p: { stage: 'upload'; percent?: number; text: string }) => void;

/** Loopback, private, link-local and other non-public ranges: never fetched for URLs that came from app entries. */
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
  // Documentation ranges (RFC 5737): never real servers.
  ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24],
] as const) NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  // Unspecified, loopback and IPv4-compatible (::a.b.c.d), unique-local, link-local, site-local (old), multicast.
  ['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  // Forms that carry an IPv4 address inside, which may be a private one: NAT64 (well-known and local-use), 6to4,
  // Teredo. Repositories and their downloads are on ordinary addresses, so these are refused outright.
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32],
  // Documentation (RFC 3849): never real servers.
  ['2001:db8::', 32],
] as const) NON_PUBLIC.addSubnet(net, prefix, 'ipv6');

export function isNonPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return NON_PUBLIC.check(mapped[1]!, 'ipv4');
  // IPv4-mapped in any other spelling (::ffff:7f00:1, 0:0:0:0:0:ffff:…): the URL parser writes it one way.
  if (isIP(address) === 6) {
    let canonical: string;
    try {
      canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    } catch {
      return true;
    }
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonical);
    if (hex) {
      const hi = Number.parseInt(hex[1]!, 16);
      const lo = Number.parseInt(hex[2]!, 16);
      return NON_PUBLIC.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
    }
  }
  const family = isIP(address);
  return family === 4 ? NON_PUBLIC.check(address, 'ipv4') : family === 6 ? NON_PUBLIC.check(address, 'ipv6') : true;
}

/**
 * GET a URL that came from an app entry or a release list (icons, screenshots, IPKs): http(s) only, redirects followed
 * by hand, and every hop outside `trustedOrigin` (the configured source itself) must be a public address — no
 * loopback, LAN or link-local.
 */
export async function safeGet(href: string, timeoutMs: number, trustedOrigin?: string, stayOn?: string, httpsOnly = false): Promise<Response> {
  return (await getFollowing(href, timeoutMs, { trustedOrigin, stayOn, httpsOnly })).res;
}

/**
 * Where an address ends up after its redirects (a short link like tinyurl.com/…, a GitHub Pages address that moved).
 * Every hop must be https on a public address, like a custom repository itself; `testRig` (LGDM_TEST_ALLOW_LOCAL_REPOS)
 * allows http and local addresses. The answer's body is not read.
 */
export async function finalUrl(href: string, timeoutMs: number, testRig = false): Promise<string> {
  const { res, url } = await getFollowing(href, timeoutMs, { httpsOnly: !testRig, anyHost: testRig });
  await res.body?.cancel().catch(() => {});
  return url.href;
}

async function getFollowing(
  href: string,
  timeoutMs: number,
  o: { trustedOrigin?: string; stayOn?: string; httpsOnly?: boolean; anyHost?: boolean },
): Promise<{ res: Response; url: URL }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = new URL(href);
  for (let hop = 0; ; hop++) {
    // `stayOn`: a repository's own files — a redirect to another site is refused, not followed.
    if (o.stayOn && url.origin !== o.stayOn) throw new RpcError(RepoErrorCodes.BadResponse, 'The repository redirected to another site.', url.href);
    if (url.protocol !== 'https:' && (o.httpsOnly || url.protocol !== 'http:')) {
      throw new RpcError(RepoErrorCodes.BadResponse, o.httpsOnly ? 'Only https links can be followed.' : 'Only http(s) links can be fetched.', url.href);
    }
    const trusted = o.anyHost || url.origin === o.trustedOrigin;
    if (!trusted) await assertPublicHost(url);
    // Outside the trusted source the connection checks the address it actually uses (pinnedGet), so a host that
    // answers DNS with a public address for the check and 127.0.0.1 a moment later still can't reach this computer.
    const res = trusted ? await fetch(url, { redirect: 'manual', signal, headers: { accept: '*/*' } }) : await pinnedGet(url, signal);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return { res, url };
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
  o: { url: string; id: string; size?: number; sha256?: string; budget: UploadBudget; trustedOrigin?: string; httpsOnly?: boolean; checksumFrom: string },
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
      const res = await safeGet(url.href, 300_000, o.trustedOrigin, undefined, o.httpsOnly).catch((e: Error) => {
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

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup for outgoing connections that refuses loopback, LAN and link-local answers. */
export function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => isNonPublicAddress(a.address))) {
      return callback(Object.assign(new Error(`Refusing to connect to a local or private network address for ${hostname}.`), { code: 'EPRIVATE' }), '');
    }
    if (options.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
}

/** A GET whose connection may only go to a public address. Answers like fetch (no redirects followed). */
function pinnedGet(url: URL, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      { method: 'GET', headers: { accept: '*/*', 'user-agent': 'lg-dev-manager-bridge' }, lookup: publicLookup as never, signal },
      (msg) => {
        const status = msg.statusCode ?? 0;
        const headers = new Headers();
        for (const [k, v] of Object.entries(msg.headers)) for (const x of [v ?? []].flat()) headers.append(k, x);
        const empty = status === 204 || status === 304;
        if (empty) msg.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(msg) as ReadableStream<Uint8Array>), { status, headers }));
      },
    );
    req.on('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'EPRIVATE' ? new RpcError(RepoErrorCodes.BadResponse, 'Refusing to fetch from a local or private network address.', url.href) : e),
    );
    req.end();
  });
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

