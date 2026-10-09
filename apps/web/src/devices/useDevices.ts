import { useEffect, useState, useSyncExternalStore } from 'react';
import { getActiveDeviceId, listDevices, subscribe, type SavedDevice } from './store';

/** Live list of saved devices plus the active one. */
export function useDevices() {
  const [devices, setDevices] = useState<SavedDevice[] | null>(null);
  const activeId = useSyncExternalStore(subscribe, getActiveDeviceId, () => null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      listDevices()
        .then((d) => alive && setDevices(d))
        .catch(() => alive && setDevices([]));
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
