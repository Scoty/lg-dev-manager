import { randomBytes } from 'node:crypto';
import { DEFAULT_BRIDGE_PORT } from '@lgdm/protocol';

/**
 * A link that pairs a browser with this bridge in one click: `<page>/#/pair?token=…`. The token sits after `#`, so the
 * browser never sends it to the server (not to lg.scoty.uk, not to a proxy, not in a Referer header), and the page
 * removes it from the address bar once read. `port`: for lg.scoty.uk, which bridge port to use (when not 5199).
 */
export function pairLink(page: string, token: string, port?: number): string {
  const base = page.replace(/\/+$/, '');
  const portPart = port && port !== DEFAULT_BRIDGE_PORT ? `&port=${port}` : '';
  return `${base}/#/pair?token=${encodeURIComponent(token)}${portPart}`;
}

/**
 * The app opens the site already paired. Handing the browser the pairing link itself would put the token in a command
 * line (`open`, `xdg-open`, `rundll32`) that other users of this computer can see in their process list, so the
 * browser gets `http://localhost:<port>/pair/<nonce>` instead: the bridge answers that once, within two minutes, with
 * a redirect to the link — and never again.
 */
const redirects = new Map<string, { target: string; until: number }>();

export function oneTimePairRedirect(target: string, ttlMs = 120_000): string {
  const nonce = randomBytes(18).toString('base64url');
  redirects.set(nonce, { target, until: Date.now() + ttlMs });
  return nonce;
}

/** The link a `/pair/<nonce>` request redirects to (used up by this call), or null. */
export function takePairRedirect(path: string): string | null {
  const m = /^\/pair\/([A-Za-z0-9_-]{16,64})$/.exec(path);
  if (!m) return null;
  const hit = redirects.get(m[1]!);
  redirects.delete(m[1]!);
  return hit && hit.until > Date.now() ? hit.target : null;
}
