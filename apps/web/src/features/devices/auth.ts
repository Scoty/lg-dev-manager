import { DEVMODE_SSH_PORT, DEVMODE_USER, ROOT_SSH_PORT, ROOT_USER, type DeviceAuth } from '@lgdm/protocol';

/** How the user is setting up a TV (mode-select.component.ts). */
export type SetupMode = 'devmode' | 'rooted' | 'manual';

export const MODE_DEFAULTS: Record<SetupMode, { port: number; username: string; fixed: boolean }> = {
  devmode: { port: DEVMODE_SSH_PORT, username: DEVMODE_USER, fixed: true },
  rooted: { port: ROOT_SSH_PORT, username: ROOT_USER, fixed: true },
  manual: { port: ROOT_SSH_PORT, username: ROOT_USER, fixed: false },
};

/** A login being filled in. `devkey` is fetched from the TV's key server when verifying. */
export type AuthDraft =
  | { kind: 'devkey'; passphrase: string }
  | { kind: 'password'; password: string }
  | { kind: 'key'; privateKey: string; passphrase: string; fileName?: string }
  | { kind: 'generated'; privateKey: string; publicKey: string; fingerprint: string }
  | { kind: 'keep' };

export type AuthKind = AuthDraft['kind'];

export const AUTH_LABELS: Record<AuthKind, string> = {
  devkey: 'Dev Mode key (passphrase)',
  password: 'Password',
  key: 'Private key',
  generated: 'New key made for this TV',
  keep: 'Keep the current login',
};

export function emptyAuth(kind: AuthKind): AuthDraft {
  switch (kind) {
    case 'devkey':
      return { kind, passphrase: '' };
    case 'password':
      return { kind, password: '' };
    case 'key':
      return { kind, privateKey: '', passphrase: '' };
    case 'generated':
      return { kind, privateKey: '', publicKey: '', fingerprint: '' };
    case 'keep':
      return { kind };
  }
}

/** Problems that block continuing, by field. Empty object = OK. */
export function authProblems(a: AuthDraft): Partial<Record<'passphrase' | 'password' | 'privateKey', string>> {
  switch (a.kind) {
    case 'devkey':
      // Only required, like the original: the key server is the real check, and formats may differ by firmware.
      return a.passphrase.trim() ? {} : { passphrase: 'Enter the passphrase shown in the Developer Mode app.' };
    case 'password':
      return a.password ? {} : { password: 'Enter the SSH password.' };
    case 'key':
      return a.privateKey.trim() ? {} : { privateKey: 'Paste a private key or choose a key file.' };
    case 'generated':
      return a.privateKey ? {} : { privateKey: 'Make a key first.' };
    case 'keep':
      return {};
  }
}

/** The stored login for drafts that don't need the TV (everything except `devkey` and `keep`). */
export function toDeviceAuth(a: AuthDraft): DeviceAuth | null {
  switch (a.kind) {
    case 'password':
      return { kind: 'password', password: a.password };
    case 'key':
      return { kind: 'key', privateKey: a.privateKey.trim() + '\n', ...(a.passphrase ? { passphrase: a.passphrase } : {}) };
    case 'generated':
      return { kind: 'key', privateKey: a.privateKey };
    default:
      return null;
  }
}

/** Host names, IPv4 and IPv6 (optionally in brackets). Not a full validator — the port check is the real test. */
export function hostProblem(host: string): string | null {
  const h = host.trim();
  if (!h) return 'Enter the TV’s IP address.';
  if (h.length > 255 || !/^(\[[0-9a-fA-F:.]+\]|[0-9a-fA-F:.]+|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)$/.test(h)) {
    return 'That doesn’t look like an IP address or host name.';
  }
  return null;
}

export function describeLogin(auth: DeviceAuth): string {
  return auth.kind === 'password' ? 'password' : auth.passphrase ? 'key + passphrase' : 'private key';
}
