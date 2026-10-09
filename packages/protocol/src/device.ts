import { z } from 'zod';

/**
 * How to log in to a TV. Lives only in the browser (IndexedDB) and is sent to the paired bridge
 * with each call; the bridge keeps it in memory only while a connection is open and never writes it to disk.
 */
export const DeviceAuth = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('key'),
    /** PEM / OpenSSH private key, as fetched from the Dev Mode key server or pasted by the user. */
    privateKey: z.string().min(1).max(64 * 1024),
    passphrase: z.string().max(1024).optional(),
  }),
  z.object({ kind: z.literal('password'), password: z.string().max(1024) }),
]);
export type DeviceAuth = z.infer<typeof DeviceAuth>;

/** POSIX-style user names. Never starts with "-", so it can't be read as an option anywhere it ends up. */
export const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
/** Host names, IPv4 and IPv6 (optionally in brackets). None of these can start with "-" or hold a path or port. */
export const HOST_RE = /^(\[[0-9a-fA-F:.]+\]|[0-9a-fA-F:.]+|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)$/;

export const HostName = z.string().min(1).max(255).regex(HOST_RE, 'Not an IP address or host name');
export const UserName = z.string().regex(USERNAME_RE, 'Not a valid user name');

/** Everything the bridge needs to reach one TV. */
export const DeviceTarget = z.object({
  host: HostName,
  port: z.number().int().min(1).max(65535),
  username: UserName,
  auth: DeviceAuth,
});
export type DeviceTarget = z.infer<typeof DeviceTarget>;

/** Well-known ports and users (from dev-manager-desktop / ares-cli-rs). */
export const DEVMODE_SSH_PORT = 9922;
export const DEVMODE_USER = 'prisoner';
export const ROOT_SSH_PORT = 22;
export const ROOT_USER = 'root';
export const KEY_SERVER_PORT = 9991;

/** Luna errors the UI may want to treat specially (mirrors remote-luna.service.ts). */
export const LunaErrorCodes = {
  Response: 'luna_error',
  UnknownMethod: 'luna_unknown_method',
  ServiceNotFound: 'luna_service_not_found',
  Unsupported: 'luna_unsupported',
  BadResponse: 'luna_bad_response',
} as const;

export const DeviceErrorCodes = {
  PassphraseRequired: 'passphrase_required',
  BadPassphrase: 'bad_passphrase',
  BadKey: 'bad_key',
  KeyNotFound: 'key_not_found',
  KeyServerUnreachable: 'key_server_unreachable',
  Unreachable: 'ssh_unreachable',
  AuthFailed: 'ssh_auth_failed',
  Timeout: 'ssh_timeout',
  CommandFailed: 'command_failed',
  /** The operation needs a different login (root, or Developer Mode's prisoner). */
  WrongLogin: 'wrong_login',
} as const;
