/**
 * Stand-ins for browser features that only work on https or localhost pages ("secure contexts"). A bridge shared on
 * the network (LAN mode) serves this app over plain HTTP at its own address, where `crypto.randomUUID` and
 * `navigator.clipboard` don't exist.
 */

/** A random id (a UUID where available). */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Copy text to the clipboard: the Clipboard API, or the older copy command where that isn't available. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // Focus comes back afterwards (the terminal keeps the keyboard after Ctrl+Shift+C).
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.fontSize = '16px'; // smaller text makes iOS zoom in on focus
  document.body.appendChild(area);
  area.focus();
  area.setSelectionRange(0, text.length); // iOS doesn't select a read-only field with select()
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only copy that works outside secure contexts
    if (!document.execCommand('copy')) throw new Error('Copy was refused.');
  } finally {
    area.remove();
    focused?.focus();
  }
}
