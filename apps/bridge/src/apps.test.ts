import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeIpk, startMockTv, type MockTv } from '@lgdm/mock-tv';
import type { DeviceTarget, OpProgress } from '@lgdm/protocol';
import { appIcon, installIpk, launchApp, listApps, removeApp } from './apps/apps.js';
import { deviceInfo, generateKey, storageInfo } from './devices/info.js';
import { RpcError } from './rpc/errors.js';
import { readIpkControl } from './apps/ipk.js';
import { SshPool } from './ssh/pool.js';
import { putFile, readFile } from './ssh/transfer.js';

const pool = new SshPool(1000);
let devTv: MockTv; // Dev Mode, SFTP, no Homebrew Channel
let streamTv: MockTv; // Dev Mode, no SFTP (cat over exec)
let rootTv: MockTv; // rooted, Homebrew Channel
let noTunnelTv: MockTv; // rooted, Homebrew Channel, remote forwarding refused

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

const collect = () => {
  const events: Omit<OpProgress, 'opId'>[] = [];
  return { events, progress: (p: Omit<OpProgress, 'opId'>) => events.push(p) };
};

const tempFiles = (tv: MockTv) => [...tv.state.files.keys()].filter((f) => f.startsWith('/media/developer/temp/'));

beforeAll(async () => {
  [devTv, streamTv, rootTv, noTunnelTv] = await Promise.all([
    startMockTv(),
    startMockTv({ sftp: false }),
    startMockTv({ username: 'root', password: 'alpine', hbchannel: true }),
    startMockTv({ username: 'root', password: 'alpine', hbchannel: true, forwarding: false }),
  ]);
});
afterAll(async () => {
  pool.close();
  await Promise.all([devTv, streamTv, rootTv, noTunnelTv].map((t) => t.close()));
});

describe('device info', () => {
  it('reads model, webOS and firmware version', async () => {
    expect(await deviceInfo(pool, devmode(devTv))).toEqual({
      modelName: 'OLED55C36LC',
      osVersion: '8.0.0',
      firmwareVersion: '03.00.00',
      socName: 'mock-tv',
    });
  });

  it('reads developer partition usage', async () => {
    expect(await storageInfo(pool, devmode(devTv))).toEqual({ total: 1_843_200, used: 638_800, available: 1_204_400 });
  });

  it('generates a key the TV accepts once authorized', async () => {
    const key = generateKey('test');
    expect(key.publicKey).toMatch(/^ssh-ed25519 \S+ test$/);
    expect(key.fingerprint).toMatch(/^SHA256:/);
    rootTv.authorize(key.publicKey);
    const res = await pool.exec({ ...rooted(rootTv), auth: { kind: 'key', privateKey: key.privateKey } }, 'id -u');
    expect(res.stdout.trim()).toBe('0');
  });
});

describe('apps', () => {
  it('lists installed apps', async () => {
    const apps = await listApps(pool, devmode(devTv));
    expect(apps.map((a) => a.id)).toEqual(['com.example.hello', 'youtube.leanback.v4', 'com.limelight.webos']);
    expect(apps[0]).toMatchObject({ title: 'Hello World', version: '1.0.0', icon: 'icon.png' });
  });

  it('launches apps and reports unknown ones', async () => {
    await launchApp(pool, devmode(devTv), 'com.example.hello');
    expect(devTv.state.launched).toContain('com.example.hello');
    expect(await code(launchApp(pool, devmode(devTv), 'com.missing'))).toBe('luna_error');
  });

  it('reads icons over SFTP and over cat', async () => {
    for (const tv of [devTv, streamTv]) {
      const [app] = await listApps(pool, devmode(tv));
      const icon = await appIcon(pool, devmode(tv), `${app!.folderPath}/${app!.icon}`);
      expect(icon.mime).toBe('image/png');
      expect(Buffer.from(icon.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    }
  });

  it('only reads image files as icons', async () => {
    expect(await code(appIcon(pool, devmode(devTv), '/etc/prefs/properties/machineName'))).toBe('bad_request');
  });

  it('refuses icons that are too large', async () => {
    devTv.state.files.set('/media/developer/big.png', Buffer.alloc(2 * 1024 * 1024));
    streamTv.state.files.set('/media/developer/big.png', Buffer.alloc(2 * 1024 * 1024));
    expect(await code(appIcon(pool, devmode(devTv), '/media/developer/big.png'))).toBe('file_too_large');
    expect(await code(appIcon(pool, devmode(streamTv), '/media/developer/big.png'))).toBe('file_too_large');
  });
});

describe('install (Dev Mode: copy + appinstalld)', () => {
  for (const [label, get] of [
    ['SFTP', () => devTv],
    ['cat over exec', () => streamTv],
  ] as const) {
    it(`installs an IPK via ${label}, reports progress and cleans up`, async () => {
      const tv = get();
      const { events, progress } = collect();
      const res = await installIpk(pool, devmode(tv), 'new.ipk', fakeIpk('com.example.new', '2.0.0', 'New App', 300_000), progress);
      expect(res).toEqual({ appId: 'com.example.new', via: 'devmode' });
      expect(tv.state.apps.find((a) => a.id === 'com.example.new')).toMatchObject({ version: '2.0.0', title: 'New App' });
      expect(tempFiles(tv)).toEqual([]);
      const stages = [...new Set(events.map((e) => e.stage))];
      expect(stages).toEqual(['upload', 'verify', 'install', 'cleanup']);
      expect(events.filter((e) => e.stage === 'upload').at(-1)?.percent).toBe(100);
      expect(events.some((e) => e.stage === 'install' && e.percent === 50)).toBe(true);
    });
  }

  it('maps a broken package to install_failed and still cleans up', async () => {
    const res = installIpk(pool, devmode(devTv), 'bad.ipk', Buffer.from('not an ipk'));
    await expect(res).rejects.toMatchObject({ code: 'install_failed', message: '-1: FAILED_IPKG_INSTALL' });
    expect(tempFiles(devTv)).toEqual([]);
  });

  it('maps errorCode -5 to insufficient_space', async () => {
    const ipk = fakeIpk('com.example.huge', '1.0.0', 'MOCK_NO_SPACE');
    expect(await code(installIpk(pool, devmode(devTv), 'huge.ipk', ipk))).toBe('insufficient_space');
  });

  it('removes apps with progress, and reports unknown ones', async () => {
    const { events, progress } = collect();
    await removeApp(pool, devmode(devTv), 'com.example.new', progress);
    expect(devTv.state.apps.some((a) => a.id === 'com.example.new')).toBe(false);
    expect(events.map((e) => e.text)).toContain('removing');
    expect(await code(removeApp(pool, devmode(devTv), 'com.example.new'))).toBe('remove_failed');
  });
});

describe('install (Homebrew Channel)', () => {
  it('serves the IPK over a reverse tunnel and lets Homebrew Channel install it', async () => {
    const { events, progress } = collect();
    const res = await installIpk(pool, rooted(rootTv), 'hb.ipk', fakeIpk('com.example.hb', '1.2.3', 'HB App', 100_000), progress);
    expect(res).toEqual({ appId: 'com.example.hb', via: 'hbchannel' });
    expect(rootTv.state.apps.some((a) => a.id === 'com.example.hb')).toBe(true);
    expect(tempFiles(rootTv)).toEqual([]);
    expect(events.map((e) => e.text)).toEqual(expect.arrayContaining(['Sending IPK to the TV…', 'Verifying…', 'Installing…']));
  });

  it('reports Homebrew Channel failures', async () => {
    await expect(installIpk(pool, rooted(rootTv), 'bad.ipk', Buffer.from('nope'))).rejects.toMatchObject({
      code: 'install_failed',
      message: 'Installation failed: -1: FAILED_IPKG_INSTALL',
    });
  });

  it('falls back to the dev install when the TV refuses the tunnel', async () => {
    const res = await installIpk(pool, rooted(noTunnelTv), 'x.ipk', fakeIpk('com.example.fallback'));
    expect(res).toEqual({ appId: 'com.example.fallback', via: 'devmode' });
  });
});

describe('file transfer', () => {
  it('writes and reads back binary data both ways', async () => {
    const data = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 256));
    for (const tv of [devTv, streamTv]) {
      expect(await putFile(pool, devmode(tv), '/media/developer/temp-check.bin', data)).toBe(tv === devTv ? 'sftp' : 'stream');
      expect((await readFile(pool, devmode(tv), '/media/developer/temp-check.bin', 1 << 20)).equals(data)).toBe(true);
    }
  });

  it('reports writes outside the Dev Mode jail', async () => {
    expect(await code(putFile(pool, devmode(devTv), '/usr/x', Buffer.from('x')))).toBe('transfer_failed');
    expect(await code(putFile(pool, devmode(streamTv), '/usr/x', Buffer.from('x')))).toBe('transfer_failed');
  });
});

describe('IPK control', () => {
  it('reads Package and Version from a real ar + control.tar.gz layout', () => {
    expect(readIpkControl(fakeIpk('org.example.kodi', '21.1.0', 'Kodi', 5000))).toMatchObject({
      Package: 'org.example.kodi',
      Version: '21.1.0',
      Description: 'Kodi',
    });
  });

  it('returns null for anything else', () => {
    expect(readIpkControl(Buffer.from('not an ipk'))).toBeNull();
    expect(readIpkControl(Buffer.from('!<arch>\nbroken'))).toBeNull();
  });
});

describe('pool', () => {
  it('limits concurrent channels per connection but finishes every command', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => pool.exec(devmode(streamTv), `echo ${i}`)));
    expect(results.map((r) => r.stdout.trim())).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
  });

  it('a graceful close lets running commands finish, then ends the connection', async () => {
    const p2 = new SshPool();
    const d = devmode(devTv);
    const running = p2.exec(d, "luna-send-pub -n 1 luna://com.palm.systemservice/osInfo/query '{}'");
    await new Promise((r) => setTimeout(r, 5)); // connecting / running
    expect(p2.close(d, { graceful: true })).toBe(1);
    expect((await running).stdout).toContain('webos_release'); // not cut off
    expect((await p2.exec(d, 'echo fresh')).stdout.trim()).toBe('fresh'); // a new connection
    p2.close();
  });

  it('a stale idle timer never closes a newer connection', async () => {
    const shortPool = new SshPool(150);
    const d = devmode(devTv);
    await shortPool.exec(d, 'id -u'); // arms the idle timer for connection A
    shortPool.close(d); // A goes away; its timer must not touch B
    const slow = shortPool.exec(d, 'sleep 1', { timeoutMs: 600 }); // B, busy past A's timer
    expect(await code(slow)).toBe('ssh_timeout'); // timed out by us, not cut by A's timer (would be another error)
    expect((await shortPool.exec(d, 'echo still-here')).stdout.trim()).toBe('still-here');
    shortPool.close();
  });
});
