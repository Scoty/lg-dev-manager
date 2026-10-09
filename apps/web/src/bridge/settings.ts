import { DEFAULT_BRIDGE_PORT } from '@lgdm/protocol';

export interface BridgeSettings {
  url: string;
  token: string;
}

const KEY = 'lgdm-bridge';

/** Host names the bridge can be reached at. It binds 127.0.0.1 only; the site's CSP allows just these. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export const BRIDGE_URL_HELP = `The bridge only runs on this computer, so its address must start with ws://127.0.0.1: or ws://localhost: (default ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}/rpc).`;

/**
 * Why a bridge address can't be used, or null when it can: a ws:// URL on this computer. The pairing token and
 * every TV's login go to this address, so anything else — another machine, wss://, a user:pass@ part — is refused.
 */
export function bridgeUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return `That isn’t a valid address. ${BRIDGE_URL_HELP}`;
  }
  if (u.protocol !== 'ws:' || !LOCAL_HOSTS.has(u.hostname) || u.username || u.password) return BRIDGE_URL_HELP;
  return null;
}

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
    // A saved address that isn't on this computer (from an older version, or planted) is ignored: re-pair.
    return s.url && s.token && !bridgeUrlProblem(s.url) ? { url: s.url, token: s.token } : null;
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
