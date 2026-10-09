import { z } from 'zod';
import { DeviceAuth, type DeviceTarget } from '@lgdm/protocol';

/**
 * Saved TVs live ONLY in this browser (IndexedDB, per site). Nothing is stored on the bridge or any server;
 * the bridge receives a device's connection details with each call and forgets them when the connection closes.
 * Data is per origin: devices added on lg.scoty.uk are not visible at http://localhost:5199 — use export/import.
 */
export const TvInfo = z.object({
  modelName: z.string().max(64).optional(),
  osVersion: z.string().max(64).optional(),
  firmwareVersion: z.string().max(64).optional(),
  /** host:port it was read from — a changed address means it needs reading again. */
  from: z.string().max(300),
  at: z.number(),
});
export type TvInfo = z.infer<typeof TvInfo>;

/** The bits of a device.info result worth keeping with a saved TV. */
export function tvInfo(d: Pick<SavedDevice, 'host' | 'port'>, info: { modelName?: string; osVersion?: string; firmwareVersion?: string }): TvInfo {
  const cut = (v?: string) => (v ? v.slice(0, 64) : undefined);
  return TvInfo.parse({
    ...(info.modelName ? { modelName: cut(info.modelName) } : {}),
    ...(info.osVersion ? { osVersion: cut(info.osVersion) } : {}),
    ...(info.firmwareVersion ? { firmwareVersion: cut(info.firmwareVersion) } : {}),
    from: `${d.host}:${d.port}`,
    at: Date.now(),
  });
}

export const SavedDevice = z.object({
  id: z.string(),
  name: z.string().min(1).max(64),
  mode: z.enum(['devmode', 'rooted']),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(64),
  auth: DeviceAuth,
  description: z.string().max(200).optional(),
  /** What the TV last said about itself (device.info), for showing its model. Refreshed in the background. */
  info: TvInfo.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SavedDevice = z.infer<typeof SavedDevice>;
export type NewDevice = Omit<SavedDevice, 'id' | 'createdAt' | 'updatedAt'>;

export const ExportFile = z.object({
  format: z.literal('lg-dev-manager/devices'),
  version: z.literal(1),
  exportedAt: z.number(),
  devices: z.array(SavedDevice),
});
export type ExportFile = z.infer<typeof ExportFile>;

const DB_NAME = 'lgdm';
const DB_VERSION = 1;
const STORE = 'devices';
const ACTIVE_KEY = 'lgdm-active-device';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    open.onsuccess = () => resolve(open.result);
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

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
/** Subscribe to any change in the device list or active device. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function listDevices(): Promise<SavedDevice[]> {
  const all = await tx('readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
  return all
    .map((d) => SavedDevice.safeParse(d))
    .flatMap((r) => (r.success ? [r.data] : []))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getDevice(id: string): Promise<SavedDevice | undefined> {
  const d = await tx('readonly', (s) => s.get(id) as IDBRequest<unknown>);
  const r = SavedDevice.safeParse(d);
  return r.success ? r.data : undefined;
}

export async function addDevice(input: NewDevice): Promise<SavedDevice> {
  const now = Date.now();
  const device = SavedDevice.parse({ ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now });
  await tx('readwrite', (s) => s.add(device));
  if (!getActiveDeviceId()) setActiveDeviceId(device.id);
  notify();
  return device;
}

export async function updateDevice(id: string, patch: Partial<NewDevice>): Promise<SavedDevice> {
  const current = await getDevice(id);
  if (!current) throw new Error('Device not found');
  const device = SavedDevice.parse({ ...current, ...patch, id, updatedAt: Date.now() });
  await tx('readwrite', (s) => s.put(device));
  notify();
  return device;
}

/** Remember what the TV said about itself. Not an edit, so `updatedAt` stays. */
export async function setDeviceInfo(id: string, info: TvInfo): Promise<void> {
  const current = await getDevice(id);
  if (!current) return;
  await tx('readwrite', (s) => s.put(SavedDevice.parse({ ...current, info })));
  notify();
}

export async function removeDevice(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
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

/** What the bridge needs for a call. Only these fields leave the browser, and only to the paired bridge. */
export function toTarget(d: Pick<SavedDevice, 'host' | 'port' | 'username' | 'auth'>): DeviceTarget {
  return { host: d.host, port: d.port, username: d.username, auth: d.auth };
}

/** Backup file. Contains private keys and passwords — the UI warns before downloading. */
export async function exportDevices(): Promise<ExportFile> {
  return { format: 'lg-dev-manager/devices', version: 1, exportedAt: Date.now(), devices: await listDevices() };
}

/** Import a backup. Devices with an id that already exists are replaced. Returns how many were imported. */
export async function importDevices(json: unknown): Promise<number> {
  const file = ExportFile.parse(json);
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(STORE, 'readwrite');
    for (const dev of file.devices) t.objectStore(STORE).put(dev);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  if (!getActiveDeviceId() && file.devices[0]) setActiveDeviceId(file.devices[0].id);
  notify();
  return file.devices.length;
}

/** Remove every saved device and the active selection from this browser. */
export async function clearAllDevices(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
  setActiveDeviceId(null);
}
