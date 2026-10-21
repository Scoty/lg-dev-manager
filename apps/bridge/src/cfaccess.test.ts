import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@lgdm/protocol';
import { CfAccess, parseAud, parseTeamDomain, viaCloudflare, type CfAccessConfig } from './cfaccess.js';
import { parseArgs } from './config.js';
import { parseNetworks } from './lan.js';
import { startServer } from './server.js';

const TEAM = 'https://hometeam.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const CONFIG: CfAccessConfig = { teamDomain: TEAM, aud: AUD, allow: ['me@example.com', 'abc123.access'] };

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

function sign(key: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = enc({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const p = enc(claims);
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}

const now = () => Math.floor(Date.now() / 1000);
const claims = (extra: Record<string, unknown> = {}) => ({ iss: TEAM, aud: [AUD], email: 'me@example.com', iat: now(), exp: now() + 3600, ...extra });

/** The team's certs endpoint, counting fetches. */
function certs(keys: object[]) {
  const calls = { n: 0 };
  const fetchImpl = (async (url: string) => {
    calls.n++;
    expect(url).toBe(`${TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('Cloudflare Access tokens', () => {
  const key = keyPair('k1');
  const other = keyPair('k2');

  it('lets in a token Access signed for this application and an allowed person or service token', async () => {
    const { fetchImpl, calls } = certs([key.jwk]);
    const access = new CfAccess(CONFIG, fetchImpl);
    expect(await access.verify(sign(key, claims()))).toMatchObject({ who: 'me@example.com' });
    expect((await access.verify(sign(key, claims({ email: undefined, common_name: 'abc123.access' })))).who).toBe('abc123.access');
    expect(calls.n).toBe(1); // keys are cached
  });

  it('refuses everything else, without ever quoting the token', async () => {
    const { fetchImpl, calls } = certs([key.jwk]);
    const access = new CfAccess(CONFIG, fetchImpl);
    const cases: [string | undefined, RegExp][] = [
      [undefined, /no Cloudflare Access token/],
      ['not-a-token', /not a token/],
      [sign(key, claims({ aud: ['b'.repeat(64)] })), /another Access application/],
      [sign(key, claims({ iss: 'https://otherteam.cloudflareaccess.com' })), /another team/],
      [sign(key, claims({ exp: now() - 3600 })), /expired/],
      [sign(key, claims({ nbf: now() + 3600 })), /not valid yet/],
      [sign(key, claims({ email: 'someone@example.com' })), /isn’t in LGDM_CF_ACCESS_ALLOW/],
      [sign(key, claims({ email: '' })), /no identity/],
      [sign(key, claims(), { alg: 'HS256' }), /unexpected token type/],
      [sign(key, claims(), { alg: 'none' }), /unexpected token type/],
      [sign({ kid: 'k1', privateKey: other.privateKey }, claims()), /bad signature/],
      [sign(other, claims()), /bad signature/], // a key the team doesn't have
    ];
    for (const [token, why] of cases) {
      const err = await access.verify(token).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message, String(token)).toMatch(why);
      if (token) expect(err?.message).not.toContain(token.split('.')[2] ?? token);
    }
    // An unknown key id doesn't fetch the keys again within a minute.
    expect(calls.n).toBe(1);
  });

  it('picks up new keys when Cloudflare rotates them', async () => {
    let keys: object[] = [key.jwk];
    let t = Date.now();
    const fetchImpl = (async () => new Response(JSON.stringify({ keys }))) as unknown as typeof fetch;
    const access = new CfAccess(CONFIG, fetchImpl, () => t);
    expect((await access.verify(sign(key, claims()))).who).toBe('me@example.com');
    keys = [other.jwk];
    t += 61_000;
    expect((await access.verify(sign(other, claims()))).who).toBe('me@example.com');
  });

  it('settings: the team, the audience tag, and only with LAN mode, an allow list and the Cloudflare hostname', () => {
    expect(parseTeamDomain('HomeTeam')).toBe(TEAM);
    expect(parseTeamDomain('https://hometeam.cloudflareaccess.com/')).toBe(TEAM);
    expect(() => parseTeamDomain('evil.example/x')).toThrow(/team name/);
    expect(() => parseAud('nope')).toThrow(/audience/);
    const env = { LGDM_TOKEN: 'a-long-enough-test-token', LGDM_LISTEN: '0.0.0.0', LGDM_PUBLIC_URL: 'http://nas.local:5199,https://tv.example.com' };
    const saved = { ...process.env };
    try {
      Object.assign(process.env, env, { LGDM_CF_ACCESS_TEAM: 'hometeam', LGDM_CF_ACCESS_AUD: AUD, LGDM_CF_ACCESS_ALLOW: 'Me@Example.com' });
      expect(parseArgs([]).lan?.cfAccess).toEqual({ teamDomain: TEAM, aud: AUD, allow: ['me@example.com'] });
      process.env.LGDM_CF_ACCESS_ALLOW = '';
      expect(() => parseArgs([])).toThrow(/needs LGDM_CF_ACCESS_ALLOW/);
      process.env.LGDM_CF_ACCESS_ALLOW = 'me@example.com';
      process.env.LGDM_PUBLIC_URL = 'http://nas.local:5199';
      expect(() => parseArgs([])).toThrow(/Cloudflare hostname/);
      delete process.env.LGDM_LISTEN;
      delete process.env.LGDM_PUBLIC_URL;
      expect(() => parseArgs([])).toThrow(/only applies to a bridge shared on your network/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('spots requests through Cloudflare', () => {
    expect(viaCloudflare({ 'cf-ray': 'x' })).toBe(true);
    expect(viaCloudflare({ 'cf-access-jwt-assertion': 'x' })).toBe(true);
    expect(viaCloudflare({ 'x-forwarded-for': '192.168.1.5' })).toBe(false);
  });
});

describe('a LAN-mode bridge behind Cloudflare Access', () => {
  const TOKEN = 'cf-access-test-token-123';
  const HOST = 'tv.example.com';
  const ORIGIN = `https://${HOST}`;
  const key = keyPair('k1');
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const lan = { publicUrls: ['http://nas.test:5199', ORIGIN], extraNetworks: parseNetworks(undefined), cfAccess: CONFIG };
    server = await startServer(
      { host: '127.0.0.1', port: 0, allowedOrigins: lan.publicUrls, token: TOKEN, dev: false, lan },
      undefined,
      undefined,
      undefined,
      new CfAccess(CONFIG, certs([key.jwk]).fetchImpl),
    );
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // What cloudflared sends on: the visitor's public address, Cloudflare's headers and (after Access) the token.
  const viaTunnel = (jwt?: string): Record<string, string> => ({
    host: HOST,
    'cf-ray': '8f00000000000000-LHR',
    'cf-connecting-ip': '203.0.113.7',
    'x-forwarded-for': '203.0.113.7',
    ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}),
  });

  const get = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/healthz', headers }, (res) => {
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

  it('lets in requests that passed Access for an allowed person, and nothing else from Cloudflare', async () => {
    expect(await get(viaTunnel(sign(key, claims())))).toBe(200);
    expect(await get(viaTunnel())).toBe(403); // a hostname without an Access application, or a Bypass policy
    expect(await get(viaTunnel(sign(key, claims({ email: 'stranger@example.com' }))))).toBe(403);
    expect(await get(viaTunnel(sign(key, claims({ aud: ['c'.repeat(64)] }))))).toBe(403);
    // The local network works as before; a public address forwarded without Cloudflare is still refused.
    expect(await get({ host: 'nas.test:5199' })).toBe(200);
    expect(await get({ host: 'nas.test:5199', 'x-forwarded-for': '203.0.113.7' })).toBe(403);
    await expect(open({ ...viaTunnel(), origin: ORIGIN })).rejects.toThrow(/403/);
  });

  it('pairs through Access with the pairing token, and ends the connection when the Access session does', async () => {
    const ws = await open({ ...viaTunnel(sign(key, claims({ exp: now() + 2 }))), origin: ORIGIN });
    const res = await new Promise<any>((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      ws.send(JSON.stringify({ id: 1, method: 'system.hello', params: { token: TOKEN, protocolVersion: PROTOCOL_VERSION } }));
    });
    expect(res.result.lan).toBe(true);
    const code = await new Promise<number>((resolve) => ws.once('close', (c) => resolve(c)));
    expect(code).toBe(4401);
  });
});
