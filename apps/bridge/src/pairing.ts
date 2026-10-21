import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * line (`open`, `xdg-open`, `rundll32`) that other users of this computer can see in their process list, and so would
 * any other secret in that line. So the app writes a small page that forwards to the link into a folder of its own
 * (0700, file 0600: readable by this user only) and opens that file: the command line names only the file. The folder
 * is removed after two minutes, or when the bridge stops.
 */
export function pairingPage(link: string, ttlMs = 120_000): { path: string; remove: () => void } {
  removeOldPairingPages(ttlMs);
  const dir = mkdtempSync(join(tmpdir(), 'lgdm-pair-'));
  const path = join(dir, 'pair.html');
  const href = JSON.stringify(link).replace(/</g, '\\u003c');
  const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>LG Dev Manager</title><script>location.replace(${href})</script>`;
  writeFileSync(path, html, { mode: 0o600, flag: 'wx' });
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    clearTimeout(timer);
    process.off('exit', remove);
    rmSync(dir, { recursive: true, force: true });
  };
  const timer = setTimeout(remove, ttlMs);
  timer.unref();
  process.once('exit', remove);
  return { path, remove };
}

/**
 * Pages left behind by an app that didn't stop cleanly (its window closed on Windows doesn't run exit handlers): this
 * user's own lgdm-pair-* folders older than the lifetime are removed. Others' can't be read or removed anyway.
 */
function removeOldPairingPages(ttlMs: number) {
  try {
    const tmp = tmpdir();
    for (const name of readdirSync(tmp)) {
      if (!/^lgdm-pair-[A-Za-z0-9]{6}$/.test(name)) continue;
      const dir = join(tmp, name);
      try {
        const st = statSync(dir);
        if (Date.now() - st.mtimeMs > ttlMs && (typeof process.getuid !== 'function' || st.uid === process.getuid())) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        /* gone, or not ours */
      }
    }
  } catch {
    /* no temporary folder to look in */
  }
}
