import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeClient } from '../bridge/client';
import { resetStorage, setStorageBridge } from '../storage/backend';
import {
  addCustomRepo,
  customReposLoaded,
  loadCustomRepos,
  MAX_CUSTOM_REPOS,
  mergeCustomRepos,
  removeCustomRepo,
  renameCustomRepo,
  resetCustomReposCache,
} from './store';

const URL_A = 'https://repo.example.com/api/apps.json';
const URL_B = 'https://other.example.org/apps.json';

describe('custom repositories saved in the browser', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCustomReposCache();
  });

  it('renames a repository (1–60 characters), and the new name survives a reload', async () => {
    const a = await addCustomRepo({ name: 'Friends', url: URL_A });
    expect((await renameCustomRepo(a.id, '  Club apps ')).name).toBe('Club apps');
    await expect(renameCustomRepo(a.id, '   ')).rejects.toThrow(/up to 60/);
    await expect(renameCustomRepo(a.id, 'x'.repeat(61))).rejects.toThrow(/up to 60/);
    await expect(renameCustomRepo('nosuchid1', 'X')).rejects.toThrow(/isn’t saved/);
    resetCustomReposCache();
    expect(loadCustomRepos().map((r) => [r.name, r.url])).toEqual([['Club apps', URL_A]]);
  });

  it('adds, refuses duplicates, removes — and survives a reload', async () => {
    const a = await addCustomRepo({ name: 'Friends', url: URL_A, apps: 4 });
    await expect(addCustomRepo({ name: 'Again', url: URL_A })).rejects.toThrow(/already added, as “Friends”/);
    await addCustomRepo({ name: 'Other', url: URL_B });
    resetCustomReposCache(); // as after reloading the page
    expect(loadCustomRepos().map((r) => r.name)).toEqual(['Friends', 'Other']);
    await removeCustomRepo(a.id);
    expect(loadCustomRepos().map((r) => r.url)).toEqual([URL_B]);
  });

  it('keeps only web addresses, and drops entries that don’t check out', async () => {
    // Any path: Homebrew Channel takes whatever answers with the index (pastebin raw pages, files without .json).
    expect((await addCustomRepo({ name: 'raw', url: 'https://paste.example.com/raw/AbCd1234' })).url).toBe('https://paste.example.com/raw/AbCd1234');
    await expect(addCustomRepo({ name: 'x', url: 'javascript:alert(1)//.json' })).rejects.toThrow();
    await expect(addCustomRepo({ name: 'x', url: 'ftp://example.com/apps.json' })).rejects.toThrow();
    await expect(addCustomRepo({ name: 'x', url: 'https://u:p@example.com/apps.json' })).rejects.toThrow();
    // Look-alike hosts are kept (and shown) in punycode.
    expect((await addCustomRepo({ name: 'lookalike', url: 'https://rеpo.webosbrew.org/api/apps.json' })).url).toMatch(/^https:\/\/xn--/);
    localStorage.setItem('lgdm-custom-repos', JSON.stringify([{ id: 'abcdef12', name: 'ok', url: URL_A, addedAt: 1 }, { id: 'bad', url: 'nope' }]));
    resetCustomReposCache();
    expect(loadCustomRepos().map((r) => r.name)).toEqual(['ok']);
    localStorage.setItem('lgdm-custom-repos', '{not json');
    resetCustomReposCache();
    expect(loadCustomRepos()).toEqual([]);
  });

  it('limits how many can be added, and merges a backup without duplicates', async () => {
    for (let i = 0; i < MAX_CUSTOM_REPOS; i++) await addCustomRepo({ name: `R${i}`, url: `https://r${i}.example.com/apps.json` });
    await expect(addCustomRepo({ name: 'one more', url: URL_B })).rejects.toThrow(/up to 20/);
    localStorage.clear();
    resetCustomReposCache();
    await addCustomRepo({ name: 'Friends', url: URL_A });
    const added = await mergeCustomRepos([
      { id: 'zzzzzz01', name: 'Friends (backup)', url: URL_A, addedAt: 1 },
      { id: 'zzzzzz02', name: 'Other', url: URL_B, addedAt: 2 },
    ]);
    expect(added).toBe(1);
    expect(loadCustomRepos().map((r) => r.name)).toEqual(['Friends', 'Other']);
    expect(loadCustomRepos()[1]!.id).not.toBe('zzzzzz02'); // a new id, never one from the file
  });
});

describe('custom repositories kept on the bridge', () => {
  /** A bridge that stores repositories, with a list another browser may change behind this page's back. */
  function fakeBridge(initial: unknown[]) {
    const state = { repos: initial, sets: 0 };
    let answer: () => void = () => {};
    const firstGet = new Promise<void>((r) => (answer = r));
    let gets = 0;
    const client = {
      on: () => () => {},
      call: async (method: string, params?: { repos: unknown[] }) => {
        if (method === 'store.repos.get') {
          if (gets++ === 0) await firstGet; // the page's own first load is slow
          return { repos: state.repos };
        }
        if (method === 'store.repos.set') {
          state.sets++;
          state.repos = params!.repos;
          return {};
        }
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as BridgeClient;
    return { client, state, answer: () => answer() };
  }

  afterEach(() => resetStorage());

  it('changes the bridge’s list as it is now, and says when it isn’t loaded yet', async () => {
    const bridge = fakeBridge([{ id: 'abcdef12', name: 'Friends', url: URL_A, addedAt: 1 }]);
    setStorageBridge(bridge.client, true);
    resetCustomReposCache();
    expect(loadCustomRepos()).toEqual([]); // not loaded yet …
    expect(customReposLoaded()).toBe(false); // … and the page knows it
    // Adding before this page's own list has arrived still keeps what's on the bridge.
    await addCustomRepo({ name: 'Other', url: URL_B });
    expect(bridge.state.repos.map((r) => (r as { name: string }).name)).toEqual(['Friends', 'Other']);
    expect(customReposLoaded()).toBe(true);
    bridge.answer();
    // Another browser removed Friends meanwhile: a rename here doesn't bring it back.
    bridge.state.repos = bridge.state.repos.slice(1);
    const other = loadCustomRepos().find((r) => r.name === 'Other')!;
    await renameCustomRepo(other.id, 'Club');
    expect(bridge.state.repos.map((r) => (r as { name: string }).name)).toEqual(['Club']);
  });
});
