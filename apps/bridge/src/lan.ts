import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { IncomingHttpHeaders } from 'node:http';

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
  /** Cloudflare Access in front (cfaccess.ts): requests through Cloudflare are let in with a valid Access token only. */
  cfAccess?: import('./cfaccess.js').CfAccessConfig;
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

/**
 * Where a client may be in LAN mode: this computer, the private ranges, link-local and CGNAT (that includes
 * Tailscale's 100.64.0.0/10). Its own list, not the SSRF blocklist: that one also holds ranges whose hosts are on the
 * internet (6to4, Teredo, NAT64), which must never count as local here.
 */
const LAN = new BlockList();
for (const [net, prefix] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['169.254.0.0', 16]] as const) {
  LAN.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) LAN.addSubnet(net, prefix, 'ipv6');

/**
 * An address in its plain form: IPv4 for IPv4-mapped IPv6 (however it's spelled), without an IPv6 zone id. Null when
 * it isn't an IP address.
 */
function plain(address: string): { address: string; family: 'ipv4' | 'ipv6' } | null {
  const a = address.trim().replace(/%[\w.-]+$/, '');
  if (isIP(a) === 4) return { address: a, family: 'ipv4' };
  if (isIP(a) !== 6) return null;
  let canonical: string;
  try {
    canonical = new URL(`http://[${a}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(canonical);
  if (dotted) return { address: dotted[1]!, family: 'ipv4' };
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonical);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return { address: `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, family: 'ipv4' };
  }
  return { address: canonical, family: 'ipv6' };
}

/**
 * This server's own IPv6 networks with global addresses (a home network's /64 from the ISP): devices on them are on
 * the LAN even though their addresses are global — and the prefix may change, so it's read from the interfaces, not
 * configured. Refreshed every minute. IPv4 networks aren't included: a server on a public IPv4 subnet (a VPS) shares
 * it with strangers.
 */
let onLink: { at: number; list: BlockList } | undefined;
function onLinkIpv6(): BlockList {
  if (onLink && Date.now() - onLink.at < 60_000) return onLink.list;
  const list = new BlockList();
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== 'IPv6' || !a.cidr) continue;
      const prefix = Number(a.cidr.split('/')[1]);
      // Only real LAN-sized prefixes; a /0–/47 "network" would be half the internet.
      if (prefix >= 48 && prefix <= 128) list.addSubnet(a.address.replace(/%.*$/, ''), prefix, 'ipv6');
    }
  }
  onLink = { at: Date.now(), list };
  return list;
}

/**
 * May a client at this address use the bridge in LAN mode? Only the local ranges above, this server's own IPv6
 * networks and networks added with LGDM_ALLOWED_NETWORKS — never an address on the internet, so a forwarded router port
 * doesn't hand the TVs to anyone who finds it. Anything that isn't a plain IP address is refused.
 */
export function isLanClient(address: string | undefined, extra?: BlockList): boolean {
  const p = address ? plain(address) : null;
  if (!p) return false;
  return LAN.check(p.address, p.family) || (p.family === 'ipv6' && onLinkIpv6().check(p.address, 'ipv6')) || !!extra?.check(p.address, p.family);
}

/** The key a client is rate-limited by: its IPv4 address, or its IPv6 /64 (a device can pick any address in it). */
export function limiterKey(address: string): string {
  const p = plain(address);
  if (!p) return address;
  if (p.family === 'ipv4') return p.address;
  const groups = p.address.includes('::') ? expand(p.address) : p.address.split(':');
  return `${groups.slice(0, 4).join(':')}::/64`;
}

function expand(v6: string): string[] {
  const [head, tail] = v6.split('::') as [string, string];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  return [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
}

/**
 * Whether a request came through Cloudflare, and the header that says so (or null): any `cf-*` header (cf-ray,
 * cf-connecting-ip, cf-visitor, cf-access-jwt-assertion, cf-warp-tag-id…), True-Client-IP, or a CDN-Loop naming
 * Cloudflare. One list for refusing such requests and for asking them for a Cloudflare Access token (cfaccess.ts).
 */
export function viaCloudflare(headers: IncomingHttpHeaders): string | null {
  for (const h of Object.keys(headers)) if (h.startsWith('cf-') || h === 'true-client-ip') return h;
  if (typeof headers['cdn-loop'] === 'string' && /cloudflare/i.test(headers['cdn-loop'])) return 'cdn-loop';
  return null;
}

/**
 * Why a request looks like it came from the internet through a proxy or tunnel (Cloudflare Tunnel, a reverse proxy
 * on the router), or null. Any Cloudflare header counts; a forwarding header counts when it names an address that
 * isn't on the local network. A reverse proxy on the LAN (Caddy, Traefik, Nginx Proxy Manager) is fine: it forwards
 * local addresses.
 */
export function forwardedProblem(headers: IncomingHttpHeaders, extra?: BlockList): string | null {
  const cf = viaCloudflare(headers);
  if (cf) return `it came through Cloudflare (${cf})`;
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
