import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@lgdm/protocol';
import { forwardedProblem, isLanClient, limiterKey, PairingLimiter, parseNetworks } from './lan.js';
import { parseArgs } from './config.js';
import { pairingPage, pairLink } from './pairing.js';
import { canOpen } from './open.js';
import { startServer } from './server.js';

describe('LAN mode building blocks', () => {
  it('lets in this computer and the local network only', () => {
    for (const a of ['127.0.0.1', '::1', '192.168.1.20', '10.0.0.5', '172.20.1.1', '100.101.102.103', 'fd00::5', 'fe80::1%eth0', '::ffff:192.168.1.20', '::ffff:c0a8:114']) {
      expect(isLanClient(a), a).toBe(true);
    }
    // Internet hosts — including ranges that only look special (6to4, Teredo, NAT64, documentation) — and non-addresses.
    for (const a of ['8.8.8.8', '140.82.112.3', '2a02:6b8::1', '::ffff:8.8.8.8', '2002:c0a8:101::1', '2001:0:4136:e378::1', '64:ff9b::808:808', '198.18.0.1', '192.0.2.1', undefined, 'not-an-ip', '']) {
      expect(isLanClient(a), String(a)).toBe(false);
    }
    expect(limiterKey('2a02:6b8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2a02:6b8:1:2::/64');
    expect(limiterKey('2a02:6b8::5')).toBe('2a02:6b8:0:0::/64');
    expect(limiterKey('::ffff:192.168.1.20')).toBe('192.168.1.20');
    // A home network on global IPv6 can be added.
    const extra = parseNetworks('2a02:6b8::/32, 198.51.100.0/24');
    expect(isLanClient('2a02:6b8::1', extra)).toBe(true);
    expect(() => parseNetworks('nope')).toThrow(/LGDM_ALLOWED_NETWORKS/);
    expect(() => parseNetworks('10.0.0.0/33')).toThrow();
  });

  it('spots requests forwarded from the internet (Cloudflare Tunnel, a proxy on the router)', () => {
    expect(forwardedProblem({})).toBeNull();
    expect(forwardedProblem({ 'cf-connecting-ip': '192.168.1.5' })).toMatch(/Cloudflare/);
    expect(forwardedProblem({ 'cf-ray': 'abc' })).toMatch(/Cloudflare/);
    expect(forwardedProblem({ 'cdn-loop': 'cloudflare; loops=1' })).toMatch(/Cloudflare/);
    expect(forwardedProblem({ 'x-forwarded-for': '8.8.8.8' })).toMatch(/8\.8\.8\.8/);
    expect(forwardedProblem({ 'x-forwarded-for': '192.168.1.5, 8.8.8.8' })).toMatch(/8\.8\.8\.8/);
    expect(forwardedProblem({ 'x-real-ip': '2a02:6b8::1' })).toMatch(/internet/);
    expect(forwardedProblem({ forwarded: 'for="[2a02:6b8::1]:443";proto=https' })).toMatch(/internet/);
    expect(forwardedProblem({ forwarded: 'for=8.8.8.8:1234' })).toMatch(/8\.8\.8\.8/);
    // A reverse proxy on the LAN forwards local addresses: fine.
    expect(forwardedProblem({ 'x-forwarded-for': '192.168.1.5', forwarded: 'for=192.168.1.5;proto=https', 'x-real-ip': '10.0.0.2' })).toBeNull();
    expect(forwardedProblem({ forwarded: 'for=unknown' })).toBeNull();
  });

  it('makes a device wait longer and longer after wrong tokens', () => {
    const l = new PairingLimiter(3, 1000, 4000, 2);
    for (let i = 0; i < 2; i++) l.failed('a', 0);
    expect(l.waitFor('a', 0)).toBe(0);
    l.failed('a', 0);
    expect(l.waitFor('a', 0)).toBe(1000);
    l.failed('a', 0);
    expect(l.waitFor('a', 0)).toBe(2000);
    for (let i = 0; i < 5; i++) l.failed('a', 0);
    expect(l.waitFor('a', 0)).toBe(4000); // capped
    expect(l.waitFor('a', 5000)).toBe(0);
    l.succeeded('a');
    l.failed('a', 0);
    expect(l.waitFor('a', 0)).toBe(0);
    // Bounded: the oldest addresses are forgotten.
    l.failed('b', 0);
    l.failed('c', 0);
    l.failed('d', 0);
    expect(l.waitFor('a', 0)).toBe(0);
  });

  it('pairing links keep the token after # and only fixed addresses can be opened', () => {
    expect(pairLink('http://nas.local:5199/', 'tok_EN-1')).toBe('http://nas.local:5199/#/pair?token=tok_EN-1');
    expect(pairLink('https://lg.scoty.uk', 'abc', 5200)).toBe('https://lg.scoty.uk/#/pair?token=abc&port=5200');
    expect(pairLink('https://lg.scoty.uk', 'abc', 5199)).toBe('https://lg.scoty.uk/#/pair?token=abc');
    expect(canOpen('https://lg.scoty.uk')).toBe(true);
    // The app opens the site through a page only this user can read: no token in the browser's command line.
    const target = pairLink('https://lg.scoty.uk', 'aB3_-x', 5200);
    const page = pairingPage(target);
    const fileUrl = pathToFileURL(page.path).href;
    expect(canOpen(fileUrl)).toBe(true);
    expect(fileUrl).not.toContain('aB3_-x');
    expect(readFileSync(page.path, 'utf8')).toContain(JSON.stringify(target));
    if (process.platform !== 'win32') {
      expect(statSync(page.path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(page.path)).mode & 0o777).toBe(0o700);
    }
    page.remove();
    expect(existsSync(page.path)).toBe(false);
    for (const bad of [target, 'http://lg.scoty.uk', 'https://lg.scoty.uk/x', 'file:///etc/passwd', 'file:///tmp/lgdm-pair-abcdef/other.html', 'http://evil.example:5199/pair/aaaaaaaaaaaaaaaaaaaa']) {
      expect(canOpen(bad), bad).toBe(false);
    }
  });
});

describe('LAN mode settings', () => {
  const env = (vars: Record<string, string | undefined>, fn: () => void) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const token = { LGDM_TOKEN: 'a-long-enough-test-token' };

  it('is off unless asked for: this computer only', () => {
    env({ ...token, LGDM_LISTEN: undefined, LGDM_PUBLIC_URL: undefined }, () => {
      const c = parseArgs([]);
      expect(c.host).toBe('127.0.0.1');
      expect(c.lan).toBeUndefined();
      expect(parseArgs(['--listen', 'localhost']).lan).toBeUndefined();
    });
  });

  it('needs the address people open it at, and a long token', () => {
    env({ ...token, LGDM_LISTEN: undefined, LGDM_PUBLIC_URL: undefined }, () => {
      expect(() => parseArgs(['--listen', '0.0.0.0'])).toThrow(/needs --public-url/);
      expect(() => parseArgs(['--public-url', 'http://nas.local:5199'])).toThrow(/only applies with --listen/);
      expect(() => parseArgs(['--listen', 'nas.local', '--public-url', 'http://nas.local:5199'])).toThrow(/IP address/);
      expect(() => parseArgs(['--listen', '0.0.0.0', '--public-url', 'ftp://nas.local'])).toThrow(/--public-url/);
      const c = parseArgs(['--listen', '0.0.0.0', '--public-url', 'http://nas.local:5199/', '--public-url', 'http://192.0.2.20:5199']);
      expect(c.host).toBe('0.0.0.0');
      expect(c.lan?.publicUrls).toEqual(['http://nas.local:5199', 'http://192.0.2.20:5199']);
      expect(c.allowedOrigins).toContain('http://nas.local:5199');
      // Shared on the network, the bridge's own page is the way in: not lg.scoty.uk (unless added).
      expect(c.allowedOrigins).not.toContain('https://lg.scoty.uk');
      expect(parseArgs(['--listen', '0.0.0.0', '--public-url', 'http://nas.local:5199', '--allow-origin', 'https://lg.scoty.uk']).allowedOrigins).toContain('https://lg.scoty.uk');
      expect(parseArgs([]).allowedOrigins).toContain('https://lg.scoty.uk'); // on this computer: as before
    });
    for (const weak of ['short', 'aaaaaaaaaaaaaaaaaaaa', 'abababababababababab']) {
      env({ LGDM_TOKEN: weak, LGDM_LISTEN: '0.0.0.0', LGDM_PUBLIC_URL: 'http://nas.local:5199' }, () => {
        expect(() => parseArgs([])).toThrow(/at least 16 characters/);
      });
    }
    env({ ...token, LGDM_LISTEN: '0.0.0.0', LGDM_PUBLIC_URL: 'https://home.example/lg' }, () => {
      expect(() => parseArgs([])).toThrow(/without a path/);
    });
    env({ ...token, LGDM_LISTEN: '0.0.0.0', LGDM_PUBLIC_URL: 'http://nas.local:5199,http://nas:5199', LGDM_ALLOWED_NETWORKS: 'bad' }, () => {
      expect(() => parseArgs([])).toThrow(/LGDM_ALLOWED_NETWORKS/);
    });
  });
});

describe('a bridge in LAN mode', () => {
  const TOKEN = 'lan-mode-test-token-1234';
  const PUBLIC = 'http://nas.test:5199';
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [PUBLIC],
      token: TOKEN,
      dev: false,
      lan: { publicUrls: [PUBLIC], extraNetworks: parseNetworks(undefined) },
    });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const get = (headers: Record<string, string>, path = '/healthz') =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

  const open = (headers: Record<string, string>) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });

  it('answers at its public address (and to this computer, for the health check)', async () => {
    expect(await get({ host: 'nas.test:5199' })).toBe(200);
    expect(await get({ host: `127.0.0.1:${port}` })).toBe(200);
    expect(await get({ host: 'evil.example:5199' }, '/')).toBe(421); // DNS rebinding
    expect(await get({ host: 'nas.test:5200' }, '/')).toBe(421);
    // The health check answers at any address (Docker probes the one it listens on); it only says it's up.
    expect(await get({ host: '192.0.2.10:5199' })).toBe(200);
  });

  it('refuses anything forwarded from the internet', async () => {
    expect(await get({ host: 'nas.test:5199', 'cf-connecting-ip': '192.168.1.5' })).toBe(403);
    expect(await get({ host: 'nas.test:5199', 'x-forwarded-for': '8.8.8.8' })).toBe(403);
    expect(await get({ host: 'nas.test:5199', 'x-forwarded-for': '192.168.1.5' })).toBe(200);
    await expect(open({ host: 'nas.test:5199', origin: PUBLIC, 'cf-ray': 'x' })).rejects.toThrow(/403/);
  });

  it('pairs a page opened at its public address and says it is shared on the network', async () => {
    await expect(open({ host: 'nas.test:5199', origin: 'http://other.test:5199' })).rejects.toThrow(/403/);
    const ws = await open({ host: 'nas.test:5199', origin: PUBLIC });
    const res = await new Promise<any>((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      ws.send(JSON.stringify({ id: 1, method: 'system.hello', params: { token: TOKEN, protocolVersion: PROTOCOL_VERSION } }));
    });
    expect(res.result.lan).toBe(true);
    ws.close();
  });

  // Last: it leaves this address rate-limited.
  it('lets a connection try one token: a burst of guesses gets nowhere, and then the device waits', async () => {
    const ws = await open({ host: 'nas.test:5199', origin: PUBLIC });
    const replies: any[] = [];
    ws.on('message', (raw) => replies.push(JSON.parse(raw.toString())));
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    const hello = (id: number, token: string) => JSON.stringify({ id, method: 'system.hello', params: { token, protocolVersion: PROTOCOL_VERSION } });
    // One write: the frames arrive together.
    const frames = [...Array.from({ length: 20 }, (_, i) => hello(i + 1, `wrong-${i}`)), hello(99, TOKEN), JSON.stringify({ id: 100, method: 'system.ping' })];
    (ws as any)._socket.write(Buffer.concat(frames.map((f) => maskedTextFrame(f))));
    expect(await closed).toBe(4401);
    expect(replies.some((r) => r.result)).toBe(false);
    // Each new connection is one more try; after a few the device must wait — even with the right token.
    for (let i = 0; i < 6; i++) {
      const c = await open({ host: 'nas.test:5199', origin: PUBLIC });
      await new Promise<void>((r) => {
        c.once('close', () => r());
        c.send(hello(1, `wrong-again-${i}`));
      });
    }
    const last = await open({ host: 'nas.test:5199', origin: PUBLIC });
    const res = await new Promise<any>((resolve) => {
      last.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      last.send(hello(1, TOKEN));
    });
    expect(res.error.code).toBe('rate_limited');
  });
});

/** A client-to-server WebSocket text frame (masked), to put several in one TCP write. */
function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, 0x80 | len]) : Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255]);
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
  return Buffer.concat([head, mask, body]);
}
