import { beforeEach, describe, expect, it } from 'vitest';
import {
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

  it('sends only connection fields to the bridge', async () => {
    const d = await addDevice({ ...tv('A'), description: 'private note' });
    expect(Object.keys(toTarget(d)).sort()).toEqual(['auth', 'host', 'port', 'username']);
  });
});
