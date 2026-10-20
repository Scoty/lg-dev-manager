import { useSyncExternalStore } from 'react';
import { STORE_CHANGED_EVENT, type StoreChanged } from '@lgdm/protocol';
import { BridgeError, type BridgeClient } from '../bridge/client';

/**
 * Where this page keeps the TVs, custom repositories and screenshots:
 * - `browser` (the default, and the only choice before 2.0): IndexedDB / localStorage, per site. Nothing leaves the
 *   browser except a TV's login, sent to the paired bridge inside the call that needs it.
 * - `bridge`: the paired bridge stores them (it was started with --store, as in the Docker image), so every browser
 *   paired with it sees the same ones. The TVs' logins go to the bridge when a TV is added or changed and never come
 *   back; calls name a stored TV by id (`{ stored: id }`).
 *
 * The bridge says which in `system.hello` (feature `serverStore`). The answer is remembered for this site, so a page
 * that stores on the bridge waits for it instead of briefly showing this browser's own (other) list.
 */
export type StorageMode = 'browser' | 'bridge';

const KEY = 'lgdm-storage';

let mode: StorageMode = (() => {
  try {
    return localStorage.getItem(KEY) === 'bridge' ? 'bridge' : 'browser';
  } catch {
    return 'browser';
  }
})();
let client: BridgeClient | null = null;
let offEvents: (() => void) | null = null;

/** Told when the mode or the connection changes (`mode`), or when the bridge says something stored changed. */
export const storageListeners = new Set<(change: StoreChanged | { what: 'mode' }) => void>();
const tell = (change: StoreChanged | { what: 'mode' }) => storageListeners.forEach((fn) => fn(change));

export function storageMode(): StorageMode {
  return mode;
}

/** Stored on the bridge, but it isn't connected right now: lists wait for it rather than show something else. */
export class StorageOffline extends BridgeError {
  constructor() {
    super('disconnected', 'Your TVs are stored on the bridge, and it isn’t connected right now.');
  }
}

/** The bridge to read from and write to, in `bridge` mode. */
export function storageClient(): BridgeClient {
  if (!client) throw new StorageOffline();
  return client;
}

/**
 * The bridge connected (`stores`: whether it stores; `client` null: it went away, the mode stays as it was).
 * Called by BridgeProvider.
 */
export function setStorageBridge(c: BridgeClient | null, stores?: boolean) {
  offEvents?.();
  offEvents = null;
  client = c && (stores ?? mode === 'bridge') ? c : null;
  if (c && stores !== undefined) {
    mode = stores ? 'bridge' : 'browser';
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* storage unavailable */
    }
  }
  if (client) offEvents = client.on(STORE_CHANGED_EVENT, (data) => tell(data as StoreChanged));
  tell({ what: 'mode' });
}

/** Unpaired from the bridge: back to this browser's own storage. */
export function resetStorage() {
  offEvents?.();
  offEvents = null;
  client = null;
  mode = 'browser';
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  tell({ what: 'mode' });
}

/** The storage mode, re-rendering when it changes. */
export function useStorageMode(): StorageMode {
  return useSyncExternalStore(
    (fn) => {
      const on = (c: { what: string }) => c.what === 'mode' && fn();
      storageListeners.add(on);
      return () => storageListeners.delete(on);
    },
    storageMode,
    storageMode,
  );
}
