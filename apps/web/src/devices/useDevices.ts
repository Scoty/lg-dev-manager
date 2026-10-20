import { useEffect, useState, useSyncExternalStore } from 'react';
import { getActiveDeviceId, listDevices, StorageOffline, subscribe, type SavedDevice } from './store';

/** Live list of saved devices plus the active one. */
export function useDevices() {
  const [devices, setDevices] = useState<SavedDevice[] | null>(null);
  const activeId = useSyncExternalStore(subscribe, getActiveDeviceId, () => null);

  useEffect(() => {
    let alive = true;
    // Only the newest load counts: when the storing bridge connects, a slower read of this browser's own list that
    // started first must not land after the bridge's list.
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      const current = () => alive && mine === seq;
      listDevices()
        .then((d) => current() && setDevices(d))
        // Stored on the bridge, which is away: keep what's shown (or "loading") until it's back.
        .catch((e: unknown) => current() && setDevices((prev) => (e instanceof StorageOffline ? prev : [])));
    };
    load();
    const off = subscribe(load);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const active = devices?.find((d) => d.id === activeId) ?? null;
  return { devices, active, activeId, loading: devices === null };
}
