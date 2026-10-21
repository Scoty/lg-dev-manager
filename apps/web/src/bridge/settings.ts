import { DEFAULT_BRIDGE_PORT, PUBLIC_WEB_ORIGIN } from '@lgdm/protocol';

export interface BridgeSettings {
  url: string;
  token: string;
}

const KEY = 'lgdm-bridge';

/** Host names the bridge can be reached at on this computer. The site's CSP allows just these (and its own origin). */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const VITE_DEV_HOSTS = ['localhost:5173', '127.0.0.1:5173'];

type Loc = Pick<Location, 'protocol' | 'host' | 'hostname'>;

const BRIDGE_URL_HELP = `The bridge runs on this computer, so its address must start with ws://127.0.0.1: or ws://localhost: (default ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}/rpc) — or, on a page a bridge on your network serves, be that page's own address.`;

/**
 * Is this page served by a bridge shared on the local network (LAN mode, the Docker image) — e.g.
 * http://nas.local:5199 — rather than by lg.scoty.uk, the Vite dev server or the bridge on this computer?
 */
export function servedByLanBridge(loc: Loc = window.location): boolean {
  if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return false;
  if (`${loc.protocol}//${loc.host}` === PUBLIC_WEB_ORIGIN || VITE_DEV_HOSTS.includes(loc.host)) return false;
  return !LOCAL_HOSTS.has(loc.hostname) && loc.hostname !== '[::1]';
}

/**
 * Why a bridge address can't be used, or null when it can: a ws:// URL on this computer, or — on a page a LAN bridge
 * serves — that page's own address (ws:// for http, wss:// behind an HTTPS proxy). The pairing token and every TV's
 * login go to this address, so anything else — another machine, a user:pass@ part — is refused: a planted setting
 * can't send them elsewhere.
 */
export function bridgeUrlProblem(url: string, loc: Loc = window.location): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return `That isn’t a valid address. ${BRIDGE_URL_HELP}`;
  }
  if (u.username || u.password) return BRIDGE_URL_HELP;
  if (u.protocol === 'ws:' && LOCAL_HOSTS.has(u.hostname)) return null;
  const sameOrigin = servedByLanBridge(loc) && u.host === loc.host && u.protocol === (loc.protocol === 'https:' ? 'wss:' : 'ws:');
  return sameOrigin ? null : BRIDGE_URL_HELP;
}

/**
 * When the UI is served by a bridge (http://localhost:5199, or a LAN bridge at http://nas.local:5199), talk to the
 * same origin. Otherwise (lg.scoty.uk, Vite dev) default to the bridge on this computer, on `port` if given.
 */
export function defaultBridgeUrl(loc: Loc = window.location, port = DEFAULT_BRIDGE_PORT): string {
  if (servedByLanBridge(loc)) return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/rpc`;
  const local = LOCAL_HOSTS.has(loc.hostname);
  const servedByBridge = loc.protocol === 'http:' && local && !VITE_DEV_HOSTS.includes(loc.host);
  if (servedByBridge) return `ws://${loc.host}/rpc`;
  return `ws://127.0.0.1:${port}/rpc`;
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
