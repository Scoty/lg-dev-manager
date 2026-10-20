import { beforeEach, describe, expect, it } from 'vitest';
import { addCustomRepo, loadCustomRepos, MAX_CUSTOM_REPOS, mergeCustomRepos, removeCustomRepo, renameCustomRepo, resetCustomReposCache } from './store';

const URL_A = 'https://repo.example.com/api/apps.json';
const URL_B = 'https://other.example.org/apps.json';

describe('custom repositories saved in the browser', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCustomReposCache();
  });

  it('renames a repository (1–60 characters), and the new name survives a reload', () => {
    const a = addCustomRepo({ name: 'Friends', url: URL_A });
    expect(renameCustomRepo(a.id, '  Club apps ').name).toBe('Club apps');
    expect(() => renameCustomRepo(a.id, '   ')).toThrow(/up to 60/);
    expect(() => renameCustomRepo(a.id, 'x'.repeat(61))).toThrow(/up to 60/);
    expect(() => renameCustomRepo('nosuchid1', 'X')).toThrow(/isn’t saved/);
    resetCustomReposCache();
    expect(loadCustomRepos().map((r) => [r.name, r.url])).toEqual([['Club apps', URL_A]]);
  });

  it('adds, refuses duplicates, removes — and survives a reload', () => {
    const a = addCustomRepo({ name: 'Friends', url: URL_A, apps: 4 });
    expect(() => addCustomRepo({ name: 'Again', url: URL_A })).toThrow(/already added, as “Friends”/);
    addCustomRepo({ name: 'Other', url: URL_B });
    resetCustomReposCache(); // as after reloading the page
    expect(loadCustomRepos().map((r) => r.name)).toEqual(['Friends', 'Other']);
    removeCustomRepo(a.id);
    expect(loadCustomRepos().map((r) => r.url)).toEqual([URL_B]);
  });

  it('keeps only web addresses, and drops entries that don’t check out', () => {
    // Any path: Homebrew Channel takes whatever answers with the index (pastebin raw pages, files without .json).
    expect(addCustomRepo({ name: 'raw', url: 'https://paste.example.com/raw/AbCd1234' }).url).toBe('https://paste.example.com/raw/AbCd1234');
    expect(() => addCustomRepo({ name: 'x', url: 'javascript:alert(1)//.json' })).toThrow();
    expect(() => addCustomRepo({ name: 'x', url: 'ftp://example.com/apps.json' })).toThrow();
    expect(() => addCustomRepo({ name: 'x', url: 'https://u:p@example.com/apps.json' })).toThrow();
    // Look-alike hosts are kept (and shown) in punycode.
    expect(addCustomRepo({ name: 'lookalike', url: 'https://rеpo.webosbrew.org/api/apps.json' }).url).toMatch(/^https:\/\/xn--/);
    localStorage.setItem('lgdm-custom-repos', JSON.stringify([{ id: 'abcdef12', name: 'ok', url: URL_A, addedAt: 1 }, { id: 'bad', url: 'nope' }]));
    resetCustomReposCache();
    expect(loadCustomRepos().map((r) => r.name)).toEqual(['ok']);
    localStorage.setItem('lgdm-custom-repos', '{not json');
    resetCustomReposCache();
    expect(loadCustomRepos()).toEqual([]);
  });

  it('limits how many can be added, and merges a backup without duplicates', () => {
    for (let i = 0; i < MAX_CUSTOM_REPOS; i++) addCustomRepo({ name: `R${i}`, url: `https://r${i}.example.com/apps.json` });
    expect(() => addCustomRepo({ name: 'one more', url: URL_B })).toThrow(/up to 20/);
    localStorage.clear();
    resetCustomReposCache();
    addCustomRepo({ name: 'Friends', url: URL_A });
    const added = mergeCustomRepos([
      { id: 'zzzzzz01', name: 'Friends (backup)', url: URL_A, addedAt: 1 },
      { id: 'zzzzzz02', name: 'Other', url: URL_B, addedAt: 2 },
    ]);
    expect(added).toBe(1);
    expect(loadCustomRepos().map((r) => r.name)).toEqual(['Friends', 'Other']);
    expect(loadCustomRepos()[1]!.id).not.toBe('zzzzzz02'); // a new id, never one from the file
  });
});
