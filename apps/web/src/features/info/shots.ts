import { useEffect, useState } from 'react';
import { SHOTS_STORE, db, req, shotListeners } from '../../devices/store';
import { randomId } from '../../lib/secureContext';
import { storageClient, storageListeners, storageMode } from '../../storage/backend';

/**
 * Screenshots live in this browser (IndexedDB, next to the saved TVs) — or on the paired bridge when it stores the
 * TVs (2.0, storage/backend.ts). The TV never keeps them: the bridge reads each capture back and deletes it from the
 * TV's /tmp straight away.
 */
export interface Shot {
  id: string;
  deviceId: string;
  /** When it was taken (ms). */
  at: number;
  method: 'DISPLAY' | 'VIDEO' | 'GRAPHIC';
  blob: Blob;
}

const isShot = (v: unknown): v is Shot => {
  const s = v as Partial<Shot> | null;
  return !!s && typeof s.id === 'string' && typeof s.deviceId === 'string' && typeof s.at === 'number' && s.blob instanceof Blob;
};

const notify = () => shotListeners.forEach((fn) => fn());

storageListeners.add((change) => {
  if (change.what === 'shots' || change.what === 'mode') notify();
});

/** Images already fetched from the bridge, by screenshot id (they never change). */
const bridgeBlobs = new Map<string, Blob>();

function toBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** One TV's screenshots, oldest first. */
export async function listShots(deviceId: string): Promise<Shot[]> {
  if (storageMode() === 'bridge') {
    const client = storageClient();
    const { shots } = await client.call('store.shots.list', { deviceId });
    return Promise.all(
      shots.map(async (s) => {
        let blob = bridgeBlobs.get(s.id);
        if (!blob) {
          const { base64, mime } = await client.call('store.shots.get', { id: s.id }, 60_000);
          blob = toBlob(base64, mime);
          bridgeBlobs.set(s.id, blob);
        }
        return { id: s.id, deviceId: s.deviceId, at: s.at, method: s.method, blob };
      }),
    );
  }
  return listBrowserShots(deviceId);
}

/** This browser's own screenshots of one TV — whatever the mode (moving them to the bridge reads these). */
export async function listBrowserShots(deviceId: string): Promise<Shot[]> {
  const d = await db();
  const all = await req(d.transaction(SHOTS_STORE, 'readonly').objectStore(SHOTS_STORE).index('deviceId').getAll(IDBKeyRange.only(deviceId)));
  return (all as unknown[]).filter(isShot).sort((a, b) => a.at - b.at);
}

export async function addShot(deviceId: string, blob: Blob, method: Shot['method']): Promise<Shot> {
  if (storageMode() === 'bridge') {
    const { shot } = await storageClient().call('store.shots.add', { deviceId, method, base64: await toBase64(blob) }, 60_000);
    bridgeBlobs.set(shot.id, blob);
    notify();
    return { id: shot.id, deviceId, at: shot.at, method, blob };
  }
  const shot: Shot = { id: randomId(), deviceId, at: Date.now(), method, blob };
  const d = await db();
  await req(d.transaction(SHOTS_STORE, 'readwrite').objectStore(SHOTS_STORE).add(shot));
  notify();
  return shot;
}

export async function deleteShots(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  if (storageMode() === 'bridge') {
    await storageClient().call('store.shots.remove', { ids: [...ids] });
    ids.forEach((id) => bridgeBlobs.delete(id));
    notify();
    return;
  }
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(SHOTS_STORE, 'readwrite');
    for (const id of ids) t.objectStore(SHOTS_STORE).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  notify();
}

/** Copy this browser's screenshots of these TVs to the bridge (moving the TVs there; storage/backend.ts). */
export async function moveBrowserShotsToBridge(deviceIds: string[]): Promise<void> {
  const client = storageClient();
  for (const deviceId of deviceIds) {
    for (const s of await listBrowserShots(deviceId)) {
      await client.call('store.shots.add', { deviceId, method: s.method, at: s.at, base64: await toBase64(s.blob) }, 60_000).catch(() => {});
    }
  }
}

/** A TV's screenshots, kept in step with changes from this page and others. */
export function useShots(deviceId: string): { shots: Shot[] | null; error: unknown } {
  const [state, setState] = useState<{ id: string; shots: Shot[] | null; error: unknown }>({ id: deviceId, shots: null, error: null });
  useEffect(() => {
    let alive = true;
    // Only the newest load counts (the storing bridge connecting while this browser's own list is still being read).
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      const current = () => alive && mine === seq;
      return listShots(deviceId).then(
        (shots) => current() && setState({ id: deviceId, shots, error: null }),
        (error: unknown) => current() && setState({ id: deviceId, shots: [], error }),
      );
    };
    void load();
    shotListeners.add(load);
    return () => {
      alive = false;
      shotListeners.delete(load);
    };
  }, [deviceId]);
  return state.id === deviceId ? state : { shots: null, error: null };
}

/** Object URLs for showing the blobs; revoked when the list changes or the page goes away. */
export function useObjectUrls(shots: readonly Shot[] | null): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    const m = new Map((shots ?? []).map((s) => [s.id, URL.createObjectURL(s.blob)] as const));
    setUrls(m);
    return () => m.forEach((u) => URL.revokeObjectURL(u));
  }, [shots]);
  return urls;
}

const slug = (v: string) => v.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'tv';

/** "Living-Room-TV-2026-10-09T17-35-53.png" */
export function shotFileName(deviceName: string, shot: Pick<Shot, 'at'>): string {
  const stamp = new Date(shot.at).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${slug(deviceName)}-${stamp}.png`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
