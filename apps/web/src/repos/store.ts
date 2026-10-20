import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { CustomRepoUrl } from '@lgdm/protocol';
import { storageClient, storageListeners, storageMode } from '../storage/backend';

/**
 * Custom (unofficial) app repositories the user added, kept in this browser like the rest of the settings — or on the
 * paired bridge when it stores them (2.0, storage/backend.ts), shared by every browser paired with it.
 * The address goes to the paired bridge inside the repo calls that need it, nowhere else.
 */
export const CustomRepo = z.object({
  id: z.string().regex(/^[a-z0-9]{6,24}$/),
  name: z.string().trim().min(1).max(60),
  // Always kept in the URL parser's spelling: a look-alike host from a shared backup (a Cyrillic "е" in "repo") shows
  // as its punycode (xn--…), not as the name it imitates.
  url: CustomRepoUrl.transform((u) => new URL(u).href),
  addedAt: z.number(),
  /** How many apps it listed when it was added (shown on the Custom repositories page). */
  apps: z.number().int().nonnegative().optional(),
});
export type CustomRepo = z.infer<typeof CustomRepo>;

const KEY = 'lgdm-custom-repos';
export const MAX_CUSTOM_REPOS = 20;

const listeners = new Set<() => void>();
let cache: CustomRepo[] | null = null;

/** On the bridge: its list once loaded (null: not yet), kept up to date from its change events. */
let bridgeList: CustomRepo[] | null = null;
let loading = false;

function loadFromBridge() {
  if (loading) return;
  loading = true;
  void (async () => {
    try {
      const { repos } = await storageClient().call('store.repos.get');
      bridgeList = repos.flatMap((r) => {
        const p = CustomRepo.safeParse(r);
        return p.success ? [p.data] : [];
      });
      cache = null;
      listeners.forEach((l) => l());
    } catch {
      /* away: tried again when it's back (storageListeners) */
    } finally {
      loading = false;
    }
  })();
}

storageListeners.add((change) => {
  if (change.what !== 'repos' && change.what !== 'mode') return;
  bridgeList = null;
  cache = null;
  if (storageMode() === 'bridge') loadFromBridge();
  listeners.forEach((l) => l());
});

/** This browser's own list (localStorage) — whatever the mode (moving it to the bridge reads this). */
export function loadBrowserRepos(): CustomRepo[] {
  return readBrowser();
}

function read(): CustomRepo[] {
  if (storageMode() === 'bridge') {
    if (!bridgeList) loadFromBridge();
    return bridgeList ?? [];
  }
  return readBrowser();
}

function readBrowser(): CustomRepo[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    const list = z.array(z.unknown()).parse(raw);
    // An entry that doesn't check out (edited by hand, older format) is left out rather than breaking the list.
    return list.flatMap((r) => {
      const p = CustomRepo.safeParse(r);
      return p.success ? [p.data] : [];
    });
  } catch {
    return [];
  }
}

export function loadCustomRepos(): CustomRepo[] {
  cache ??= read();
  return cache;
}

function save(list: CustomRepo[]) {
  cache = list;
  if (storageMode() === 'bridge') {
    // Shown at once; the bridge then tells every paired browser (this one too, which reloads its list).
    bridgeList = list;
    storageClient()
      .call('store.repos.set', { repos: list })
      .catch(() => {
        bridgeList = null;
        cache = null;
        loadFromBridge();
      });
  } else {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable: kept for this visit only */
    }
  }
  listeners.forEach((l) => l());
}

/** Move this browser's own list to the bridge (adding to what it has), then clear it here. */
export async function moveBrowserReposToBridge(): Promise<number> {
  const mine = readBrowser();
  if (!mine.length) return 0;
  const { repos } = await storageClient().call('store.repos.get');
  const known = new Set(repos.map((r) => r.url));
  const merged = [...repos, ...mine.filter((r) => !known.has(r.url))].slice(0, MAX_CUSTOM_REPOS);
  await storageClient().call('store.repos.set', { repos: merged });
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  return mine.length;
}

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);

export function addCustomRepo(r: { name: string; url: string; apps?: number }): CustomRepo {
  const list = loadCustomRepos();
  let href: string;
  try {
    href = new URL(r.url).href;
  } catch {
    throw new Error('That isn’t a web address.');
  }
  const dup = list.find((x) => x.url === href);
  if (dup) throw new Error(`That repository is already added, as “${dup.name}”.`);
  if (list.length >= MAX_CUSTOM_REPOS) throw new Error(`You can add up to ${MAX_CUSTOM_REPOS} repositories.`);
  const repo = CustomRepo.parse({ id: newId(), name: r.name, url: r.url, addedAt: Date.now(), apps: r.apps });
  save([...list, repo]);
  return repo;
}

/** Give a saved repository another name (1–60 characters). Returns the updated entry. */
export function renameCustomRepo(id: string, name: string): CustomRepo {
  const list = loadCustomRepos();
  const repo = list.find((r) => r.id === id);
  if (!repo) throw new Error('That repository isn’t saved any more.');
  const parsed = CustomRepo.shape.name.safeParse(name);
  if (!parsed.success) throw new Error('Enter a name of up to 60 characters.');
  const updated = { ...repo, name: parsed.data };
  save(list.map((r) => (r.id === id ? updated : r)));
  return updated;
}

export function removeCustomRepo(id: string) {
  save(loadCustomRepos().filter((r) => r.id !== id));
}

/**
 * From a backup (after the user agreed): repositories with an address that isn't saved yet are added, under new ids
 * so a crafted file can't reuse one that's here already. Returns how many.
 */
export function mergeCustomRepos(repos: CustomRepo[]): number {
  const list = loadCustomRepos();
  const known = new Set(list.map((r) => r.url));
  const added = repos
    .filter((r) => !known.has(r.url))
    .filter((r, i, all) => all.findIndex((x) => x.url === r.url) === i)
    .slice(0, Math.max(0, MAX_CUSTOM_REPOS - list.length))
    .map((r) => ({ ...r, id: newId() }));
  if (added.length) save([...list, ...added]);
  return added.length;
}

function subscribe(l: () => void) {
  listeners.add(l);
  // Another tab added or removed one.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY || storageMode() === 'bridge') return;
    cache = null;
    l();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

/** The custom repositories, re-rendering when they change (in this tab or another). */
export function useCustomRepos(): CustomRepo[] {
  return useSyncExternalStore(subscribe, loadCustomRepos, loadCustomRepos);
}

/** For tests: forget the in-memory copy. */
export function resetCustomReposCache() {
  cache = null;
}
