import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOCK_DEVMODE_TOKEN, startMockLge, startMockTv, type MockLge, type MockTv } from '@lgdm/mock-tv';
import type { DeviceTarget } from '@lgdm/protocol';
import { devModeStatus, devModeToken, renewDevMode } from './devices/devmode.js';
import { SHOT_SWEEP_AGE_MS, takeScreenshot } from './devices/info.js';
import { RpcError } from './rpc/errors.js';
import { SshPool } from './ssh/pool.js';
import { LoggedSsh } from './ssh/logged.js';

const pool = new SshPool(1000);
let devTv: MockTv;
let noTokenTv: MockTv;
let rootTv: MockTv;
let legacyTv: MockTv;
let lge: MockLge;

const devmode = (tv: MockTv): DeviceTarget => ({
  host: tv.host,
  port: tv.sshPort,
  username: 'prisoner',
  auth: { kind: 'key', privateKey: tv.privateKey, passphrase: tv.passphrase },
});
const rooted = (tv: MockTv): DeviceTarget => ({ host: tv.host, port: tv.sshPort, username: 'root', auth: { kind: 'password', password: 'alpine' } });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof RpcError ? e.code : `non-rpc: ${(e as Error).message}`;
  }
  return 'no error';
}

beforeAll(async () => {
  [devTv, noTokenTv, rootTv, legacyTv, lge] = await Promise.all([
    startMockTv(),
    startMockTv({ devmodeToken: null }),
    startMockTv({ username: 'root', password: 'alpine' }),
    startMockTv({ username: 'root', password: 'alpine', legacyCapture: true }),
    startMockLge({ tokens: { [MOCK_DEVMODE_TOKEN]: (999 * 3600 + 59 * 60) * 1000 } }),
  ]);
  devTv.state.onDevmodeExtend = () => lge.sessions.set(MOCK_DEVMODE_TOKEN, Date.now() + 1000 * 3600 * 1000);
});
afterAll(async () => {
  pool.close();
  await Promise.all([devTv.close(), noTokenTv.close(), rootTv.close(), legacyTv.close(), lge.close()]);
});

describe('Developer Mode session', () => {
  it('reads the token and the time left from LG', async () => {
    expect(await devModeToken(pool, devmode(devTv))).toBe(MOCK_DEVMODE_TOKEN);
    const s = await devModeStatus(pool, devmode(devTv), lge.url);
    expect(s.token).toBe(MOCK_DEVMODE_TOKEN);
    expect(s.remaining).toMatch(/^999:5\d:\d\d$/);
  });

  it('says when there is no token, or LG rejects or can’t be reached', async () => {
    expect(await devModeStatus(pool, devmode(noTokenTv), lge.url)).toEqual({});
    noTokenTv.state.files.set('/var/luna/preferences/devmode_enabled', Buffer.from('not a token!'));
    expect(await devModeStatus(pool, devmode(noTokenTv), lge.url)).toEqual({});
    noTokenTv.state.files.set('/var/luna/preferences/devmode_enabled', Buffer.from('UNKNOWNTOKEN1'));
    expect(await devModeStatus(pool, devmode(noTokenTv), lge.url)).toEqual({ token: 'UNKNOWNTOKEN1', problem: 'Session token is not valid' });
    expect((await devModeStatus(pool, devmode(devTv), 'http://127.0.0.1:1/secure')).problem).toMatch(/Couldn’t ask LG/);
  });

  it('renews by launching the Developer Mode app with extend', async () => {
    lge.sessions.set(MOCK_DEVMODE_TOKEN, Date.now() + 5 * 3600 * 1000);
    expect((await devModeStatus(pool, devmode(devTv), lge.url)).remaining).toMatch(/^0[45]:/);
    await renewDevMode(pool, devmode(devTv));
    expect(devTv.state.devmodeExtends).toBe(1);
    expect(devTv.state.launched).toContain('com.palmdts.devmode');
    expect((await devModeStatus(pool, devmode(devTv), lge.url)).remaining).toMatch(/^(999|1000):/);
  });

  it('is only for Dev Mode logins', async () => {
    expect(await code(devModeStatus(pool, rooted(rootTv), lge.url))).toBe('wrong_login');
    expect(await code(renewDevMode(pool, rooted(rootTv)))).toBe('wrong_login');
  });

  it('never shows the token in the console', async () => {
    const logs: string[] = [];
    const logged = new LoggedSsh(pool, (e) => logs.push(JSON.stringify(e)));
    const traced: string[] = [];
    await devModeStatus(pool, devmode(devTv), lge.url, async (_t, c, fn) => (traced.push(c), fn()));
    await renewDevMode(logged, devmode(devTv));
    expect([...logs, ...traced].join('\n')).not.toContain(MOCK_DEVMODE_TOKEN);
    expect(traced).toEqual([`GET ${lge.url}/CheckDevModeSession.dev?sessionToken=…`]);
  });
});

describe('screenshots', () => {
  it('captures a PNG and cleans up', async () => {
    const shot = await takeScreenshot(pool, rooted(rootTv), 'GRAPHIC');
    expect(shot.mime).toBe('image/png');
    expect(Buffer.from(shot.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect([...rootTv.state.files.keys()].filter((f) => f.startsWith('/tmp/devman_shot_'))).toEqual([]);
  });

  it('sweeps captures an interrupted run left behind, but not recent ones', async () => {
    const old = `/tmp/devman_shot_${Date.now() - SHOT_SWEEP_AGE_MS - 60_000}.png`;
    const recent = `/tmp/devman_shot_${Date.now() - 10_000}.png`;
    rootTv.state.files.set(old, Buffer.from('x'));
    rootTv.state.files.set(recent, Buffer.from('x'));
    rootTv.state.files.set('/tmp/other.png', Buffer.from('x'));
    await takeScreenshot(pool, rooted(rootTv));
    expect(rootTv.state.files.has(old)).toBe(false);
    expect(rootTv.state.files.has(recent)).toBe(true);
    expect(rootTv.state.files.has('/tmp/other.png')).toBe(true);
    rootTv.state.files.delete(recent);
    rootTv.state.files.delete('/tmp/other.png');
  });

  it('falls back to the older capture service, at 1920×1080 when it insists on a size', async () => {
    const shot = await takeScreenshot(pool, rooted(legacyTv));
    expect(Buffer.from(shot.base64, 'base64').length).toBeGreaterThan(100);
  });

  it('needs root', async () => {
    expect(await code(takeScreenshot(pool, devmode(devTv)))).toBe('wrong_login');
  });
});
