import { useEffect, useState } from 'react';
import { SHOTS_STORE, db, req, shotListeners } from '../../devices/store';

/**
 * Screenshots live only in this browser (IndexedDB, next to the saved TVs). The TV never keeps them: the bridge
 * reads each capture back and deletes it from the TV's /tmp straight away.
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

/** One TV's screenshots, oldest first. */
export async function listShots(deviceId: string): Promise<Shot[]> {
  const d = await db();
  const all = await req(d.transaction(SHOTS_STORE, 'readonly').objectStore(SHOTS_STORE).index('deviceId').getAll(IDBKeyRange.only(deviceId)));
  return (all as unknown[]).filter(isShot).sort((a, b) => a.at - b.at);
}

export async function addShot(deviceId: string, blob: Blob, method: Shot['method']): Promise<Shot> {
  const shot: Shot = { id: crypto.randomUUID(), deviceId, at: Date.now(), method, blob };
  const d = await db();
  await req(d.transaction(SHOTS_STORE, 'readwrite').objectStore(SHOTS_STORE).add(shot));
  notify();
  return shot;
}

export async function deleteShots(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(SHOTS_STORE, 'readwrite');
    for (const id of ids) t.objectStore(SHOTS_STORE).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  notify();
}

/** A TV's screenshots, kept in step with changes from this page and others. */
export function useShots(deviceId: string): { shots: Shot[] | null; error: unknown } {
  const [state, setState] = useState<{ id: string; shots: Shot[] | null; error: unknown }>({ id: deviceId, shots: null, error: null });
  useEffect(() => {
    let alive = true;
    const load = () =>
      listShots(deviceId).then(
        (shots) => alive && setState({ id: deviceId, shots, error: null }),
        (error: unknown) => alive && setState({ id: deviceId, shots: [], error }),
      );
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
