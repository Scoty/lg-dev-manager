import { spawn } from 'node:child_process';

/**
 * Opens a fixed https URL in the default browser (the standalone app does this on start). Best effort: a computer
 * without a browser or a desktop just doesn't get the tab. The URL is a constant, never user or web input.
 */
export function openInBrowser(url: string): void {
  if (!/^https:\/\/[a-z0-9.-]+\/?$/i.test(url)) return;
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
  } catch {
    /* no way to open a browser here */
  }
}
