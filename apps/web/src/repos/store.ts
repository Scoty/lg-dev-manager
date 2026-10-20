import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { CustomRepoUrl } from '@lgdm/protocol';

/**
 * Custom (unofficial) app repositories the user added, kept only in this browser like the rest of the settings.
 * The address goes to the paired bridge inside the repo calls that need it, nowhere else.
 */
export const CustomRepo = z.object({
  id: z.string().regex(/^[a-z0-9]{6,24}$/),
  name: z.string().trim().min(1).max(60),
  url: CustomRepoUrl,
  addedAt: z.number(),
  /** How many apps it listed when it was added (shown on the Custom repositories page). */
  apps: z.number().int().nonnegative().optional(),
});
export type CustomRepo = z.infer<typeof CustomRepo>;

const KEY = 'lgdm-custom-repos';
export const MAX_CUSTOM_REPOS = 20;

const listeners = new Set<() => void>();
let cache: CustomRepo[] | null = null;

function read(): CustomRepo[] {
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
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: kept for this visit only */
  }
  listeners.forEach((l) => l());
}

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);

export function addCustomRepo(r: { name: string; url: string; apps?: number }): CustomRepo {
  const list = loadCustomRepos();
  const dup = list.find((x) => x.url === r.url);
  if (dup) throw new Error(`That repository is already added, as “${dup.name}”.`);
  if (list.length >= MAX_CUSTOM_REPOS) throw new Error(`You can add up to ${MAX_CUSTOM_REPOS} repositories.`);
  const repo = CustomRepo.parse({ id: newId(), name: r.name, url: r.url, addedAt: Date.now(), apps: r.apps });
  save([...list, repo]);
  return repo;
}

export function removeCustomRepo(id: string) {
  save(loadCustomRepos().filter((r) => r.id !== id));
}

/** From a backup: repositories with an address that isn't saved yet are added. Returns how many. */
export function mergeCustomRepos(repos: CustomRepo[]): number {
  const list = loadCustomRepos();
  const known = new Set(list.map((r) => r.url));
  const added = repos.filter((r) => !known.has(r.url)).slice(0, Math.max(0, MAX_CUSTOM_REPOS - list.length));
  if (added.length) save([...list, ...added]);
  return added.length;
}

function subscribe(l: () => void) {
  listeners.add(l);
  // Another tab added or removed one.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
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
