import { spawn } from 'node:child_process';

/**
 * Opens a fixed URL in the default browser (the standalone app does this on start). Best effort: a computer without a
 * browser or a desktop just doesn't get the tab. The URL is made by the bridge, never user or web input — and nothing
 * else gets past canOpen.
 */
export function openInBrowser(url: string): boolean {
  if (!canOpen(url)) return false;
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false; // no way to open a browser here
  }
}

/**
 * The only URLs openInBrowser opens: an https site's root, or the app's own pairing page in a temporary folder
 * (pairing.ts) — never a token.
 */
export function canOpen(url: string): boolean {
  return /^https:\/\/[a-z0-9.-]+\/?$/i.test(url) || /^file:\/\/\/[^?#\s]*\/lgdm-pair-[A-Za-z0-9]{6}\/pair\.html$/.test(url);
}
