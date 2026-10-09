/**
 * Rules for a TV's address and SSH user name, shared by the add / edit forms, backup import and the renew
 * script, so a value that couldn't be typed in can't arrive any other way either.
 */

import { HOST_RE, USERNAME_RE } from '@lgdm/protocol';

// The same rules the bridge applies to every call (packages/protocol/src/device.ts).
export { USERNAME_RE };

export const isValidUsername = (u: string) => USERNAME_RE.test(u);

/** Not a full validator — the port check is the real test. Leading/trailing spaces are ignored (the forms trim). */
export function hostProblem(host: string): string | null {
  const h = host.trim();
  if (!h) return 'Enter the TV’s IP address.';
  if (h.length > 255 || !HOST_RE.test(h)) return 'That doesn’t look like an IP address or host name.';
  return null;
}

/** A host as stored: valid and already trimmed. */
export const isValidHost = (host: string) => host === host.trim() && hostProblem(host) === null;
