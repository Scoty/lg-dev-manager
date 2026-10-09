import { createSocket } from 'node:dgram';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { ScanResult } from '@lgdm/protocol';
import { anyOpen, checkConnection, DEFAULT_PORTS, type PortSet } from './ports.js';

/**
 * Find LG TVs on the local network, two ways at once:
 *  - SSDP: LG TVs answer M-SEARCH for their second-screen / DIAL services with a description URL
 *    (friendly name, model);
 *  - a quick sweep of this computer's /24 networks for the webOS second-screen port (3000/3001), which is
 *    open whenever a webOS TV is on — even with SSH off, so we can tell the user what to turn on.
 * Each TV found is then port-checked (22, 9922, 9991). Only outgoing connections; nothing listens.
 */

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = ['urn:lge-com:service:webos-second-screen:1', 'urn:dial-multiscreen-org:service:dial:1'];
const SWEEP_CONCURRENCY = 96;
const SWEEP_TIMEOUT_MS = 600;
const MAX_NETWORKS = 4;
/** Interfaces that are virtual / VPN and not where a TV would be. */
const SKIP_IFACE = /^(docker|br-|veth|vmnet|vboxnet|virbr|tailscale|zt|utun|awdl|llw|lo)/i;

export interface ScanOptions {
  timeoutMs?: number;
  ssdp?: boolean;
  /** /24 prefixes to sweep, e.g. "192.168.1". Defaults to this computer's networks. */
  networks?: string[];
  /** Extra single hosts to check (dev rigs; LGDM_SCAN_EXTRA_HOSTS). */
  extraHosts?: string[];
  ports?: PortSet;
}

interface SsdpHit {
  host: string;
  location?: string;
  server?: string;
  st?: string;
}

export function parseSsdpResponse(msg: string, from: string): SsdpHit | null {
  const lines = msg.split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200/i.test(lines[0] ?? '') && !/^NOTIFY /i.test(lines[0] ?? '')) return null;
  const h: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  const isLg = /webos/i.test(h.server ?? '') || /lge-com/i.test(h.st ?? '') || /lge-com/i.test(h.nt ?? '');
  if (!isLg) return null;
  return { host: from, location: h.location, server: h.server, st: h.st };
}

/** friendlyName / modelName from a UPnP device description. */
export function parseDescription(xml: string): { name?: string; modelName?: string } {
  const tag = (t: string) => {
    const m = new RegExp(`<${t}>([^<]{1,200})</${t}>`, 'i').exec(xml);
    return m?.[1]?.trim() || undefined;
  };
  const unescape = (s?: string) => s?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return { name: unescape(tag('friendlyName')), modelName: unescape(tag('modelName')) };
}

function ssdpSearch(timeoutMs: number): Promise<SsdpHit[]> {
  return new Promise((resolve) => {
    const hits = new Map<string, SsdpHit>();
    let sock: ReturnType<typeof createSocket>;
    try {
      sock = createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      return resolve([]);
    }
    const done = () => {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve([...hits.values()]);
    };
    sock.on('error', done);
    sock.on('message', (buf, rinfo) => {
      const hit = parseSsdpResponse(buf.toString('utf8'), rinfo.address);
      if (hit && !hits.has(hit.host)) hits.set(hit.host, hit);
    });
    sock.bind(0, () => {
      for (const st of SEARCH_TARGETS) {
        const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        sock.send(msg, SSDP_PORT, SSDP_ADDR, () => {});
      }
      setTimeout(done, timeoutMs);
    });
  });
}

/** GET the description XML, only from the host that answered (no fetching arbitrary URLs). */
function fetchDescription(hit: SsdpHit): Promise<{ name?: string; modelName?: string }> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(hit.location ?? '');
    } catch {
      return resolve({});
    }
    if (url.protocol !== 'http:' || url.hostname !== hit.host) return resolve({});
    const req = request(url, { method: 'GET', timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy();
      });
      res.on('end', () => resolve(parseDescription(body)));
      res.on('error', () => resolve({}));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({}));
    req.end();
  });
}

/** The /24 networks this computer is on (skipping loopback, VPN and container interfaces). */
export function localNetworks(): { prefixes: string[]; self: Set<string> } {
  const prefixes: string[] = [];
  const self = new Set<string>();
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (SKIP_IFACE.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // link-local
      self.add(a.address);
      const prefix = a.address.split('.').slice(0, 3).join('.');
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
    }
  }
  return { prefixes: prefixes.slice(0, MAX_NETWORKS), self };
}

async function sweep(hosts: string[], ports: readonly number[]): Promise<string[]> {
  const found: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const h = hosts[next++]!;
      if (await anyOpen(h, ports, SWEEP_TIMEOUT_MS)) found.push(h);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, hosts.length) }, worker));
  return found;
}

const ipKey = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + (Number(p) || 0), 0);

export async function scanNetwork(opts: ScanOptions = {}): Promise<ScanResult[]> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const ports = opts.ports ?? DEFAULT_PORTS;
  const local = opts.networks ? { prefixes: opts.networks, self: new Set<string>() } : localNetworks();
  const extra = opts.extraHosts ?? (process.env.LGDM_SCAN_EXTRA_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []);
  const sweepHosts = [
    ...local.prefixes.flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`)),
    ...extra,
  ].filter((h) => !local.self.has(h));

  const [ssdpHits, swept] = await Promise.all([
    opts.ssdp === false ? Promise.resolve([]) : ssdpSearch(timeoutMs),
    sweep([...new Set(sweepHosts)], ports.webos),
  ]);

  const byHost = new Map<string, { via: Set<'ssdp' | 'sweep'>; hit?: SsdpHit }>();
  for (const h of ssdpHits) byHost.set(h.host, { via: new Set(['ssdp']), hit: h });
  for (const h of swept) {
    const e = byHost.get(h) ?? { via: new Set() };
    e.via.add('sweep');
    byHost.set(h, e);
  }

  const results = await Promise.all(
    [...byHost.entries()].map(async ([host, e]): Promise<ScanResult> => {
      const [desc, p] = await Promise.all([e.hit ? fetchDescription(e.hit) : Promise.resolve<{ name?: string; modelName?: string }>({}), checkConnection(host, ports, 1500)]);
      return {
        host,
        ...(desc.name ? { name: desc.name } : {}),
        ...(desc.modelName ? { modelName: desc.modelName } : {}),
        // SSDP only answers from webOS TVs, so treat an SSDP hit as webOS even if 3000/3001 were slow.
        ports: { ...p, webos: p.webos || e.via.has('ssdp') },
        via: [...e.via].sort(),
      };
    }),
  );
  return results.sort((a, b) => ipKey(a.host) - ipKey(b.host));
}
