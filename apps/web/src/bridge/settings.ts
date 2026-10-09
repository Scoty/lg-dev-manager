import { DEFAULT_BRIDGE_PORT } from '@lgdm/protocol';

export interface BridgeSettings {
  url: string;
  token: string;
}

const KEY = 'lgdm-bridge';

/**
 * When the UI is served by the bridge itself (e.g. on a NAS), talk to the same origin.
 * Otherwise (GitHub Pages, Vite dev) default to a bridge on this computer.
 */
export function defaultBridgeUrl(loc: Pick<Location, 'protocol' | 'host' | 'hostname'> = window.location): string {
  const servedByBridge = loc.protocol === 'http:' && !['localhost:5173', '127.0.0.1:5173'].includes(loc.host);
  if (servedByBridge) return `ws://${loc.host}/rpc`;
  return `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}/rpc`;
}

export function loadSettings(): BridgeSettings | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<BridgeSettings>;
    return s.url && s.token ? { url: s.url, token: s.token } : null;
  } catch {
    return null;
  }
}

export function saveSettings(s: BridgeSettings | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}
