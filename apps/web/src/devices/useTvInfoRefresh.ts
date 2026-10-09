import { useEffect, useRef } from 'react';
import { useRpc } from '../bridge/useRpc';
import { setDeviceInfo, toTarget, tvInfo, TV_INFO_VERSION } from './store';
import { useDevices } from './useDevices';

/** Re-read the model / webOS version at most this often (it changes only with a firmware update). */
const MAX_AGE = 24 * 60 * 60 * 1000;

/**
 * Keeps the active TV's model and webOS version current: reads `device.info` in the background when it's
 * missing (TVs saved before this existed), stale, saved by an older version, or read from a different address. Tries each TV once per
 * page load, so a TV that's off doesn't get asked over and over.
 */
export function useTvInfoRefresh() {
  const { ready, call } = useRpc();
  const { active } = useDevices();
  const tried = useRef(new Set<string>());

  useEffect(() => {
    if (!ready || !active) return;
    const from = `${active.host}:${active.port}`;
    const fresh = active.info && active.info.from === from && active.info.v === TV_INFO_VERSION && Date.now() - active.info.at < MAX_AGE;
    const key = `${active.id}@${from}`;
    if (fresh || tried.current.has(key)) return;
    tried.current.add(key);
    call('device.info', { device: toTarget(active), quiet: true }, 40_000)
      .then((info) => setDeviceInfo(active.id, tvInfo(active, info)))
      .catch(() => {});
  }, [ready, active, call]);
}
