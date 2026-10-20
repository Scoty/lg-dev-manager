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
