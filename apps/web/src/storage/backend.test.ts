import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeClient } from '../bridge/client';
import { resetStorage, setStorageBridge, storageMode } from './backend';
import { listDevices, toTarget, updateDevice } from '../devices/store';
import { addCustomRepo, loadCustomRepos, resetCustomReposCache } from '../repos/store';

/** A bridge that stores (feature serverStore), recording what the page sends it. */
function fakeBridge() {
  const sent: { method: string; params: any }[] = [];
  const devices = [
    { id: 'tv-1', name: 'Living Room', mode: 'rooted', host: '192.0.2.10', port: 22, username: 'root', login: { kind: 'password' }, createdAt: 1, updatedAt: 1 },
  ];
  const client = {
    call: async (method: string, params: any) => {
      sent.push({ method, params });
      if (method === 'store.devices.list') return { devices };
      if (method === 'store.devices.save') return { device: { ...params.device, login: { kind: 'password' }, createdAt: 1, updatedAt: 2, auth: undefined } };
      if (method === 'store.repos.get') return { repos: [] };
      return {};
    },
    on: () => () => {},
  } as unknown as BridgeClient;
  return { client, sent };
}

describe('TVs stored on the bridge', () => {
  afterEach(() => {
    resetStorage();
    resetCustomReposCache();
    localStorage.clear();
  });

  it('come from the bridge, are named by id in calls, and keep their login when edited', async () => {
    const { client, sent } = fakeBridge();
    setStorageBridge(client, true);
    expect(storageMode()).toBe('bridge');
    const [tv] = await listDevices();
    expect(tv).toMatchObject({ id: 'tv-1', name: 'Living Room', login: { kind: 'password' } });
    expect(tv!.auth).toBeUndefined();
    expect(toTarget(tv!)).toEqual({ stored: 'tv-1' });
    await updateDevice('tv-1', { name: 'Bedroom' });
    const save = sent.find((s) => s.method === 'store.devices.save')!;
    expect(save.params.device).toMatchObject({ id: 'tv-1', name: 'Bedroom' });
    expect(save.params.device).not.toHaveProperty('auth'); // no login sent: the bridge keeps the stored one
    // The mode is remembered for this site, so the page waits for the bridge next time.
    expect(localStorage.getItem('lgdm-storage')).toBe('bridge');
  });

  it('custom repositories are saved to the bridge, not to this browser', async () => {
    const { client, sent } = fakeBridge();
    setStorageBridge(client, true);
    addCustomRepo({ name: 'Club', url: 'https://club.example/repo.json' });
    expect(loadCustomRepos().map((r) => r.name)).toEqual(['Club']);
    expect(sent.some((s) => s.method === 'store.repos.set' && s.params.repos[0].name === 'Club')).toBe(true);
    expect(localStorage.getItem('lgdm-custom-repos')).toBeNull();
  });

  it('a bridge that doesn’t store puts everything back in this browser', () => {
    const { client } = fakeBridge();
    setStorageBridge(client, false);
    expect(storageMode()).toBe('browser');
    expect(toTarget({ id: 'x', host: '192.0.2.1', port: 22, username: 'root', auth: { kind: 'password', password: 'pw' } })).toMatchObject({ host: '192.0.2.1' });
  });
});
