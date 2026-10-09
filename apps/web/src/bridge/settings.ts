import { DEFAULT_BRIDGE_PORT } from '@lgdm/protocol';

export interface BridgeSettings {
  url: string;
  token: string;
}

const KEY = 'lgdm-bridge';

/**
 * When the UI is served by the bridge itself (http://localhost:5199), talk to the same origin.
 * Otherwise (lg.scoty.uk, Vite dev) default to the bridge on this computer.
 */
export function defaultBridgeUrl(loc: Pick<Location, 'protocol' | 'host' | 'hostname'> = window.location): string {
  const local = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
  const servedByBridge = loc.protocol === 'http:' && local && !['localhost:5173', '127.0.0.1:5173'].includes(loc.host);
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
