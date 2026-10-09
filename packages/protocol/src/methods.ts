import { z } from 'zod';
import { DeviceTarget } from './device';
import { AppId, AppInfo, MAX_CHUNK_BYTES, MAX_UPLOAD_BYTES } from './apps';

/**
 * Bumped when the wire contract changes in a way an older peer can't handle (including new methods the
 * UI depends on), so a stale bridge gets a clear "update" message instead of unknown_method errors.
 *  v2 — M3: device.info/storage/generateKey, apps.*, upload.*
 */
export const PROTOCOL_VERSION = 2;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Not base64');
/** Absolute POSIX path without `..` segments. */
const RemotePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\0'), 'Not an absolute path');

/** Default port the bridge listens on (and serves the UI from). */
export const DEFAULT_BRIDGE_PORT = 5199;

/**
 * Method registry. Each entry pairs a params schema with a result schema.
 * Add new RPCs here first, then implement them in apps/bridge and call them from apps/web.
 * Naming: `<area>.<verb>` — see AGENTS.md.
 */
export const Methods = {
  /** First message on every connection. Authenticates with the pairing token. */
  'system.hello': {
    params: z.object({
      token: z.string().min(1),
      protocolVersion: z.number().int(),
      client: z.string().optional(),
    }),
    result: z.object({
      protocolVersion: z.number().int(),
      bridgeVersion: z.string(),
      platform: z.string(),
    }),
  },
  'system.ping': {
    params: z.object({}).optional(),
    result: z.object({ now: z.number() }),
  },

  /** Which of the TV's SSH (22, 9922) and Dev Mode key server (9991) ports answer. */
  'device.checkConnection': {
    params: z.object({ host: z.string().min(1).max(255) }),
    result: z.object({ ssh22: z.boolean(), ssh9922: z.boolean(), keyServer: z.boolean() }),
  },
  /**
   * Fetch the Dev Mode private key from the TV's key server (port 9991) and check the passphrase
   * shown in the Developer Mode app. Errors: passphrase_required, bad_passphrase, key_not_found, key_server_unreachable.
   */
  'device.fetchKey': {
    params: z.object({ host: z.string().min(1).max(255), passphrase: z.string().optional() }),
    result: z.object({ privateKey: z.string(), fingerprint: z.string() }),
  },
  /** Check that a private key parses with the given passphrase. */
  'device.verifyKey': {
    params: z.object({ privateKey: z.string().min(1), passphrase: z.string().optional() }),
    result: z.object({ fingerprint: z.string(), type: z.string() }),
  },
  /** Log in once and report who we are — used by the add-device wizard. */
  'device.test': {
    params: z.object({ device: DeviceTarget }),
    result: z.object({ latencyMs: z.number(), root: z.boolean() }),
  },
  /**
   * Model, webOS and firmware version — what the add-device wizard shows after a test login.
   * Port of DeviceManagerService.getDeviceInfo. Fields the TV doesn't report are omitted.
   */
  'device.info': {
    params: z.object({ device: DeviceTarget }),
    result: z.object({
      modelName: z.string().optional(),
      osVersion: z.string().optional(),
      firmwareVersion: z.string().optional(),
      otaId: z.string().optional(),
      socName: z.string().optional(),
    }),
  },
  /** `df` of the developer partition (KiB). Null if the TV gave no usable answer. */
  'device.storage': {
    params: z.object({ device: DeviceTarget }),
    result: z.object({ total: z.number(), used: z.number(), available: z.number() }).nullable(),
  },
  /**
   * Make a new ed25519 key pair for a TV (the original's "App key"). The private key goes back to the
   * browser to be saved with the device; the bridge keeps nothing.
   */
  'device.generateKey': {
    params: z.object({ comment: z.string().max(64).optional() }),
    result: z.object({ privateKey: z.string(), publicKey: z.string(), fingerprint: z.string() }),
  },
  /** Forget pooled SSH connections (all, or for one device). */
  'device.disconnect': {
    params: z.object({ device: DeviceTarget.optional() }),
    result: z.object({ closed: z.number() }),
  },

  /** Run a shell command and wait for it to finish. stdin/stdout/stderr are UTF-8 text. */
  'cmd.exec': {
    params: z.object({
      device: DeviceTarget,
      command: z.string().min(1),
      stdin: z.string().optional(),
      timeoutMs: z.number().int().min(100).max(600_000).optional(),
    }),
    result: z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().nullable() }),
  },

  /**
   * One-shot luna-send call. `public` uses luna-send-pub (works in Dev Mode); otherwise luna-send (root).
   * A `returnValue: false` response is an error (luna_error) unless `falseAsError` is false.
   */
  'luna.call': {
    params: z.object({
      device: DeviceTarget,
      uri: z.string().regex(/^luna:\/\/[\w.\-/]+$/, 'Not a luna:// URI'),
      params: z.record(z.unknown()).optional(),
      public: z.boolean().optional(),
      falseAsError: z.boolean().optional(),
    }),
    result: z.record(z.unknown()),
  },

  /** Installed apps: `applicationManager/dev/listApps`, falling back to `listApps` (app-manager.service.ts). */
  'apps.list': {
    params: z.object({ device: DeviceTarget }),
    result: z.object({ apps: z.array(AppInfo) }),
  },
  'apps.launch': {
    params: z.object({ device: DeviceTarget, id: AppId, params: z.record(z.unknown()).optional() }),
    result: z.object({}),
  },
  /** An app's icon file, for the apps list. Image files only, up to 1 MiB. */
  'apps.icon': {
    params: z.object({ device: DeviceTarget, path: RemotePath }),
    result: z.object({ mime: z.string(), base64: z.string() }),
  },
  /** Uninstall via `appInstallService/dev/remove`. Streams `op.progress` (stage `remove`). */
  'apps.remove': {
    params: z.object({ device: DeviceTarget, id: AppId, opId: z.string().max(64) }),
    result: z.object({}),
  },
  /**
   * Install an IPK previously sent with `upload.*`. Uses Homebrew Channel's installer when the TV has it
   * (served to the TV over an SSH reverse tunnel), otherwise copies it to /media/developer/temp and runs
   * `appInstallService/dev/install`. Streams `op.progress`. The upload is discarded afterwards.
   */
  'apps.install': {
    params: z.object({ device: DeviceTarget, uploadId: z.string().max(64), opId: z.string().max(64) }),
    result: z.object({ appId: z.string().optional(), via: z.enum(['devmode', 'hbchannel']) }),
  },

  /**
   * Send a file from the browser to the bridge in chunks. It is kept in the bridge's memory (never on disk),
   * belongs to this connection, and is dropped when used, discarded, or the connection closes.
   */
  'upload.begin': {
    params: z.object({ name: z.string().min(1).max(255), size: z.number().int().min(1).max(MAX_UPLOAD_BYTES) }),
    result: z.object({ uploadId: z.string() }),
  },
  'upload.chunk': {
    params: z.object({
      uploadId: z.string().max(64),
      offset: z.number().int().min(0),
      data: base64.max(Math.ceil(MAX_CHUNK_BYTES / 3) * 4),
    }),
    result: z.object({ received: z.number() }),
  },
  'upload.discard': {
    params: z.object({ uploadId: z.string().max(64) }),
    result: z.object({}),
  },
} as const;

export type MethodName = keyof typeof Methods;
export type ParamsOf<M extends MethodName> = z.input<(typeof Methods)[M]['params']>;
export type ResultOf<M extends MethodName> = z.output<(typeof Methods)[M]['result']>;

/** Methods that may be called before `system.hello` succeeds. */
export const UNAUTHENTICATED_METHODS: readonly MethodName[] = ['system.hello'];

/** Where the public web UI is hosted. */
export const PUBLIC_WEB_ORIGIN = 'https://lg.scoty.uk';

/** Origins the bridge always accepts: the public site and the Vite dev server. */
export const DEFAULT_ALLOWED_ORIGINS = [PUBLIC_WEB_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'] as const;

export const REPO_URL = 'https://github.com/Scoty/lg-dev-manager';
