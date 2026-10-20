import { BlockList, isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { isNonPublicAddress } from './repo/repo.js';

/**
 * LAN mode (2.0, opt-in): the bridge runs on a home server or NAS — usually the Docker image — and browsers on the
 * local network open its page. It is only ever switched on explicitly (`--listen` + `--public-url`); otherwise the
 * bridge listens on 127.0.0.1 as before. These are the extra guards that come with it.
 */
export interface LanConfig {
  /** Addresses people open the bridge at, e.g. http://nas.local:5199 (origins). */
  publicUrls: string[];
  /** Networks allowed besides the private ranges (LGDM_ALLOWED_NETWORKS), e.g. a global IPv6 /56 at home. */
  extraNetworks: BlockList;
}

/** `LGDM_ALLOWED_NETWORKS`: comma-separated CIDRs (192.0.2.0/24, 2001:db8::/56). */
export function parseNetworks(csv: string | undefined): BlockList {
  const list = new BlockList();
  for (const raw of (csv ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^/]+)\/(\d{1,3})$/.exec(raw);
    const family = m ? isIP(m[1]!) : 0;
    const prefix = m ? Number(m[2]) : -1;
    if (!m || !family || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
      throw new Error(`LGDM_ALLOWED_NETWORKS: "${raw}" isn't a network like 192.0.2.0/24 or 2001:db8::/56`);
    }
    list.addSubnet(m[1]!, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

/** Strip the IPv4-mapped prefix Node reports for IPv4 clients on a dual-stack socket. */
const plain = (address: string) => address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/**
 * May a client at this address use the bridge in LAN mode? Only this computer, the private / link-local / CGNAT
 * ranges (that includes Tailscale's 100.64.0.0/10) and networks added with LGDM_ALLOWED_NETWORKS — never an address
 * on the internet, so a forwarded router port doesn't hand the TVs to anyone who finds it.
 */
export function isLanClient(address: string | undefined, extra?: BlockList): boolean {
  if (!address) return false;
  const a = plain(address);
  const family = isIP(a);
  if (!family) return false;
  // isNonPublicAddress also counts multicast and documentation ranges; no real client connects from those.
  return isNonPublicAddress(a) || !!extra?.check(a, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Why a request looks like it came from the internet through a proxy or tunnel (Cloudflare Tunnel, a reverse proxy
 * on the router), or null. Any Cloudflare header counts; a forwarding header counts when it names an address that
 * isn't on the local network. A reverse proxy on the LAN (Caddy, Traefik, Nginx Proxy Manager) is fine: it forwards
 * local addresses.
 */
export function forwardedProblem(headers: IncomingHttpHeaders, extra?: BlockList): string | null {
  for (const h of ['cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'true-client-ip']) {
    if (headers[h] !== undefined) return `it came through Cloudflare (${h})`;
  }
  if (typeof headers['cdn-loop'] === 'string' && /cloudflare/i.test(headers['cdn-loop'])) return 'it came through Cloudflare (cdn-loop)';
  const named: string[] = [];
  const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : (v ?? ''));
  for (const part of list(headers['x-forwarded-for']).split(',')) if (part.trim()) named.push(part.trim());
  for (const part of list(headers['x-real-ip']).split(',')) if (part.trim()) named.push(part.trim());
  for (const m of list(headers.forwarded).matchAll(/for=("[^"]*"|[^;,\s]+)/gi)) named.push(m[1]!.replace(/^"|"$/g, '').trim());
  for (const raw of named) {
    // "1.2.3.4:5678" or "[2001:db8::1]:443" forms carry a port.
    const address = raw.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1');
    if (address.toLowerCase() === 'unknown' || address.startsWith('_')) continue; // RFC 7239 obfuscated ids
    if (!isLanClient(address, extra)) return `it was forwarded for ${isIP(address) ? address : 'an address'} on the internet`;
  }
  return null;
}

/**
 * Wrong pairing tokens per client address: after a few, that address waits longer and longer before it may try again.
 * The generated token (128 random bits) can't be guessed anyway; this protects a short LGDM_TOKEN someone chose, and
 * keeps the logs readable.
 */
export class PairingLimiter {
  private entries = new Map<string, { fails: number; until: number }>();

  constructor(
    private readonly freeTries = 5,
    private readonly baseMs = 30_000,
    private readonly maxMs = 15 * 60_000,
    private readonly maxEntries = 1000,
  ) {}

  /** Milliseconds this address must still wait, or 0. */
  waitFor(address: string, now = Date.now()): number {
    const e = this.entries.get(address);
    return e && e.until > now ? e.until - now : 0;
  }

  failed(address: string, now = Date.now()) {
    const e = this.entries.get(address) ?? { fails: 0, until: 0 };
    e.fails++;
    if (e.fails >= this.freeTries) e.until = now + Math.min(this.maxMs, this.baseMs * 2 ** (e.fails - this.freeTries));
    this.entries.delete(address);
    this.entries.set(address, e);
    // Oldest first: a flood of addresses can't grow this without bound.
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(key);
    }
  }

  succeeded(address: string) {
    this.entries.delete(address);
  }
}
