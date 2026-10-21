import { z } from 'zod';
import { CustomRepo, loadCustomRepos, MAX_CUSTOM_REPOS, mergeCustomRepos } from '../repos/store';
import { DeviceAuth, LoginSummary, type DeviceTarget, type StoredDevice, type StoredDeviceInput } from '@lgdm/protocol';
import { StorageOffline, storageClient, storageListeners, storageMode } from '../storage/backend';
import { hostProblem, isValidUsername } from './validate';
import { randomId } from '../lib/secureContext';

/**
 * Saved TVs live in this browser (IndexedDB, per site) — or, when the paired bridge stores them (2.0, `--store`, the
 * Docker image; storage/backend.ts), on the bridge, shared by every browser paired with it. In the browser, the bridge
 * receives a device's connection details with each call and forgets them when the connection closes; on the bridge,
 * the login is sent once and never comes back (a stored TV has `login`, not `auth`).
 * Browser data is per origin: devices added on lg.scoty.uk are not visible at http://localhost:5199 — use export/import.
 */
export const TvInfo = z.object({
  modelName: z.string().max(64).optional(),
  osVersion: z.string().max(64).optional(),
  firmwareVersion: z.string().max(64).optional(),
  /** SoC name (e.g. "k8lp"), for Homebrew apps that only run on some chips. */
  socName: z.string().max(64).optional(),
  /** host:port it was read from — a changed address means it needs reading again. */
  from: z.string().max(300),
  at: z.number(),
  /** Which fields this record was read with — older records get read again (see useTvInfoRefresh). */
  v: z.number().optional(),
});

/** Bump when TvInfo gains a field, so saved TVs pick it up. 2: socName. */
export const TV_INFO_VERSION = 2;
export type TvInfo = z.infer<typeof TvInfo>;

/** The bits of a device.info result worth keeping with a saved TV. */
export function tvInfo(
  d: Pick<SavedDevice, 'host' | 'port'>,
  info: { modelName?: string; osVersion?: string; firmwareVersion?: string; socName?: string },
): TvInfo {
  const cut = (v?: string) => (v ? v.slice(0, 64) : undefined);
  return TvInfo.parse({
    ...(info.modelName ? { modelName: cut(info.modelName) } : {}),
    ...(info.osVersion ? { osVersion: cut(info.osVersion) } : {}),
    ...(info.firmwareVersion ? { firmwareVersion: cut(info.firmwareVersion) } : {}),
    ...(info.socName ? { socName: cut(info.socName) } : {}),
    from: `${d.host}:${d.port}`,
    at: Date.now(),
    v: TV_INFO_VERSION,
  });
}

export const SavedDevice = z.object({
  id: z.string(),
  name: z.string().min(1).max(64),
  mode: z.enum(['devmode', 'rooted']),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(64),
  /** The login — in this browser. A TV stored on the bridge has none here (the bridge keeps it): see `login`. */
  auth: DeviceAuth.optional(),
  /** A TV stored on the bridge: what kind of login it has (the bridge never sends the login itself). */
  login: LoginSummary.optional(),
  description: z.string().max(200).optional(),
  /** What the TV last said about itself (device.info), for showing its model. Refreshed in the background. */
  info: TvInfo.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SavedDevice = z.infer<typeof SavedDevice>;
export type NewDevice = Omit<SavedDevice, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * A device as read from a backup file. Stricter than SavedDevice: the address and user name must pass the same
 * rules as the add / edit forms, so a hand-made backup can't slip in values the forms would refuse
 * (e.g. a user name like "-oProxyCommand=…").
 */
const ImportedDevice = SavedDevice.omit({ login: true }).extend({
  auth: DeviceAuth,
  host: z.string().trim().refine((h) => hostProblem(h) === null, 'Not a valid IP address or host name.'),
  username: z.string().refine(isValidUsername, 'Not a valid user name.'),
});

export const ExportFile = z.object({
  format: z.literal('lg-dev-manager/devices'),
  version: z.literal(1),
  exportedAt: z.number(),
  devices: z.array(ImportedDevice).max(500),
  /** Custom repositories (Setup → Custom repositories), from 1.0.5. Older backups don't have them. */
  customRepos: z.array(CustomRepo).max(MAX_CUSTOM_REPOS).optional(),
});
export type ExportFile = z.infer<typeof ExportFile>;

/** Why a backup was refused, in words for the user (never echoes keys or passwords). */
export class BackupError extends Error {
  override name = 'BackupError';
}

const NOT_A_BACKUP = 'That file is not an LG Dev Manager device backup.';

function describeBackupProblem(error: z.ZodError, json: unknown): string {
  const issue = error.issues.find((i) => i.path[0] === 'devices' && typeof i.path[1] === 'number');
  if (!issue) return NOT_A_BACKUP;
  const index = issue.path[1] as number;
  const raw = (json as { devices?: { name?: unknown }[] }).devices?.[index]?.name;
  const label = typeof raw === 'string' && raw.trim() ? `“${raw.trim().slice(0, 64)}”` : `number ${index + 1}`;
  const field = issue.path[2];
  const what =
    field === 'username'
      ? 'has a user name that isn’t allowed'
      : field === 'host'
        ? 'has an address that isn’t an IP address or host name'
        : 'has settings this app can’t use';
  return `Nothing was imported: TV ${label} in this backup ${what}. Only import backups you made yourself.`;
}

const DB_NAME = 'lgdm';
/** 2: screenshots (features/info/shots.ts). */
const DB_VERSION = 2;
const STORE = 'devices';
export const SHOTS_STORE = 'screenshots';
const ACTIVE_KEY = 'lgdm-active-device';

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
/** This browser's database: saved TVs and the screenshots taken of them. */
export function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(SHOTS_STORE)) d.createObjectStore(SHOTS_STORE, { keyPath: 'id' }).createIndex('deviceId', 'deviceId');
    };
    open.onsuccess = () => {
      // Another tab upgrading the database: let it, and reopen on next use.
      open.result.onversionchange = () => {
        open.result.close();
        dbPromise = null;
      };
      resolve(open.result);
    };
    open.onerror = () => {
      dbPromise = null;
      reject(open.error);
    };
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return req(fn(d.transaction(STORE, mode).objectStore(STORE)));
}

/** Delete every screenshot of one TV (index 'deviceId'). */
async function deleteDeviceShots(deviceId: string): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(SHOTS_STORE, 'readwrite');
    const cur = t.objectStore(SHOTS_STORE).index('deviceId').openKeyCursor(IDBKeyRange.only(deviceId));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      t.objectStore(SHOTS_STORE).delete(c.primaryKey);
      c.continue();
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  shotListeners.forEach((fn) => fn());
}

async function clearShots(): Promise<void> {
  const d = await db();
  await req(d.transaction(SHOTS_STORE, 'readwrite').objectStore(SHOTS_STORE).clear());
  shotListeners.forEach((fn) => fn());
}

/** Told when screenshots are added or removed (features/info/shots.ts subscribes). */
export const shotListeners = new Set<() => void>();

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
/** Subscribe to any change in the device list or active device. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- On the bridge (storage/backend.ts) ----

let bridgeCache: SavedDevice[] | null = null;
storageListeners.add((change) => {
  if (change.what !== 'devices' && change.what !== 'mode') return;
  bridgeCache = null;
  notify();
});

const fromStored = (d: StoredDevice): SavedDevice => ({ ...d, auth: undefined });

async function bridgeList(): Promise<SavedDevice[]> {
  if (bridgeCache) return bridgeCache;
  const { devices } = await storageClient().call('store.devices.list');
  bridgeCache = devices.map(fromStored).sort((a, b) => a.name.localeCompare(b.name));
  return bridgeCache;
}

/** What the bridge stores of a TV: the record without what it sends back itself, the login only if there is one. */
function toStoredInput(d: SavedDevice): StoredDeviceInput {
  return {
    id: d.id,
    name: d.name,
    mode: d.mode,
    host: d.host,
    port: d.port,
    username: d.username,
    ...(d.description ? { description: d.description } : {}),
    ...(d.info ? { info: d.info } : {}),
    ...(d.auth ? { auth: d.auth } : {}),
  };
}

async function bridgeSave(d: SavedDevice): Promise<SavedDevice> {
  const { device } = await storageClient().call('store.devices.save', { device: toStoredInput(d) });
  bridgeCache = null;
  return fromStored(device);
}

/** Thrown by the lists when they're kept on the bridge and it's away: useDevices then waits ("loading"). */
export { StorageOffline };

// ---- Dispatch: this browser, or the bridge ----

export async function listDevices(): Promise<SavedDevice[]> {
  return storageMode() === 'bridge' ? bridgeList() : listBrowserDevices();
}

/** The TVs in this browser's own storage — whatever the mode (moving them to the bridge reads these). */
export async function listBrowserDevices(): Promise<SavedDevice[]> {
  const all = await tx('readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
  return all
    .map((d) => SavedDevice.safeParse(d))
    .flatMap((r) => (r.success ? [r.data] : []))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function getDevice(id: string): Promise<SavedDevice | undefined> {
  if (storageMode() === 'bridge') return (await bridgeList()).find((d) => d.id === id);
  const d = await tx('readonly', (s) => s.get(id) as IDBRequest<unknown>);
  const r = SavedDevice.safeParse(d);
  return r.success ? r.data : undefined;
}

export async function addDevice(input: NewDevice): Promise<SavedDevice> {
  const now = Date.now();
  let device = SavedDevice.parse({ ...input, id: randomId(), createdAt: now, updatedAt: now });
  if (storageMode() === 'bridge') device = await bridgeSave(device);
  else await tx('readwrite', (s) => s.add(device));
  if (!getActiveDeviceId()) setActiveDeviceId(device.id);
  notify();
  return device;
}

export async function updateDevice(id: string, patch: Partial<NewDevice>): Promise<SavedDevice> {
  const current = await getDevice(id);
  if (!current) throw new Error('Device not found');
  // On the bridge, no `auth` in the patch keeps the stored login.
  let device = SavedDevice.parse({ ...current, ...patch, auth: patch.auth ?? current.auth, id, updatedAt: Date.now() });
  if (storageMode() === 'bridge') device = await bridgeSave(device);
  else await tx('readwrite', (s) => s.put(device));
  notify();
  return device;
}

/** Remember what the TV said about itself. Not an edit, so `updatedAt` stays. */
export async function setDeviceInfo(id: string, info: TvInfo): Promise<void> {
  const current = await getDevice(id);
  if (!current) return;
  if (storageMode() === 'bridge') {
    await storageClient().call('store.devices.setInfo', { id, info });
    bridgeCache = null;
  } else await tx('readwrite', (s) => s.put(SavedDevice.parse({ ...current, info })));
  notify();
}

/** Remove a TV, and the screenshots taken of it. */
export async function removeDevice(id: string): Promise<void> {
  if (storageMode() === 'bridge') {
    // The bridge removes its screenshots too.
    await storageClient().call('store.devices.remove', { id });
    bridgeCache = null;
  } else {
    await tx('readwrite', (s) => s.delete(id));
    await deleteDeviceShots(id).catch(() => {});
  }
  if (getActiveDeviceId() === id) {
    const rest = await listDevices();
    setActiveDeviceId(rest[0]?.id ?? null);
  }
  notify();
}

export function getActiveDeviceId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function setActiveDeviceId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* storage unavailable */
  }
  notify();
}

/**
 * What the bridge needs for a call. Only these fields leave the browser, and only to the paired bridge. A TV stored on
 * the bridge is named by its id instead (`{ stored }`, which the bridge swaps for the full target before the call runs
 * — the type says DeviceTarget because every call accepts either).
 */
export function toTarget(d: Pick<SavedDevice, 'id' | 'host' | 'port' | 'username' | 'auth'>): DeviceTarget {
  if (!d.auth) return { stored: d.id } as unknown as DeviceTarget;
  return { host: d.host, port: d.port, username: d.username, auth: d.auth };
}

/**
 * Backup file. Contains private keys and passwords — the UI warns before downloading. This browser's own TVs only: the
 * bridge never hands out the logins it stores (back up its data folder instead).
 */
export async function exportDevices(): Promise<ExportFile> {
  if (storageMode() === 'bridge') throw new BackupError('Your TVs are stored on the bridge, which never sends their logins back. Back up its data folder instead.');
  const customRepos = loadCustomRepos();
  const devices = (await listBrowserDevices()).flatMap((d) => (d.auth ? [{ ...d, auth: d.auth }] : []));
  return { format: 'lg-dev-manager/devices', version: 1, exportedAt: Date.now(), devices, ...(customRepos.length ? { customRepos } : {}) };
}

/**
 * The custom repositories a backup would add (ones not saved here yet). A backup can come from someone else, and a
 * repository can carry malware, so the page asks before adding these (importDevices `customRepos`).
 */
export function newCustomReposIn(json: unknown): CustomRepo[] {
  const parsed = ExportFile.safeParse(json);
  if (!parsed.success || !parsed.data.customRepos) return [];
  const known = new Set(loadCustomRepos().map((r) => r.url));
  return parsed.data.customRepos.filter((r) => !known.has(r.url));
}

/**
 * Import a backup. Devices with an id that already exists are replaced. Returns how many were imported.
 * All or nothing: one bad device rejects the whole file with a BackupError. Its custom repositories are added only
 * with `customRepos: true` — after the user agreed to them.
 */
export async function importDevices(json: unknown, opts: { customRepos?: boolean } = {}): Promise<number> {
  const parsed = ExportFile.safeParse(json);
  if (!parsed.success) throw new BackupError(describeBackupProblem(parsed.error, json));
  const file = parsed.data;
  if (storageMode() === 'bridge') {
    await storageClient().call('store.devices.import', { devices: file.devices.map((d) => ({ ...toStoredInput(d), createdAt: d.createdAt, updatedAt: d.updatedAt })) });
    bridgeCache = null;
  } else {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const t = d.transaction(STORE, 'readwrite');
      for (const dev of file.devices) t.objectStore(STORE).put(dev);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
  if (!getActiveDeviceId() && file.devices[0]) setActiveDeviceId(file.devices[0].id);
  if (file.customRepos && opts.customRepos) mergeCustomRepos(file.customRepos);
  notify();
  return file.devices.length;
}

/**
 * Move this browser's own TVs (with their logins and screenshots) and custom repositories to the bridge, then remove
 * them from this browser. For a page whose bridge stores them (storage/backend.ts). Returns how many TVs moved.
 */
export async function moveBrowserDataToBridge(
  moveShots: (deviceIds: string[]) => Promise<number>,
  moveRepos: () => Promise<void>,
): Promise<{ tvs: number; shotsLeft: number }> {
  // Repositories first: the one step that can be refused for being too many, before anything else moves.
  await moveRepos();
  const local = (await listBrowserDevices()).filter((d) => d.auth);
  let shotsLeft = 0;
  if (local.length) {
    await storageClient().call('store.devices.import', { devices: local.map((d) => ({ ...toStoredInput(d), createdAt: d.createdAt, updatedAt: d.updatedAt })) });
    bridgeCache = null;
    shotsLeft = await moveShots(local.map((d) => d.id));
  }
  await tx('readwrite', (s) => s.clear());
  // Screenshots the bridge didn't take stay in this browser rather than be lost.
  if (!shotsLeft) await clearShots().catch(() => {});
  notify();
  return { tvs: local.length, shotsLeft };
}

/** Remove every saved device, their screenshots and the active selection from this browser. */
export async function clearAllDevices(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
  await clearShots().catch(() => {});
  setActiveDeviceId(null);
}
