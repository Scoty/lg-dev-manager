import { z } from 'zod';
import { DeviceTarget } from './device';

/** Bumped when the wire contract changes incompatibly. UI and bridge must agree. */
export const PROTOCOL_VERSION = 1;

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
export const DOCKER_IMAGE = 'ghcr.io/scoty/lg-dev-manager';
