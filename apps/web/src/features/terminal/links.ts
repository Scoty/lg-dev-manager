/**
 * Links in the terminal come from the TV (plain URLs, and OSC 8 hyperlinks a program on the TV can print with
 * any text and any target). Only http(s) addresses are opened, in a new tab without access to this page.
 */
export function safeLinkUrl(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function openTerminalLink(uri: string): void {
  const url = safeLinkUrl(uri);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}
