import { z } from 'zod';

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
} as const;

export type MethodName = keyof typeof Methods;
export type ParamsOf<M extends MethodName> = z.input<(typeof Methods)[M]['params']>;
export type ResultOf<M extends MethodName> = z.output<(typeof Methods)[M]['result']>;

/** Methods that may be called before `system.hello` succeeds. */
export const UNAUTHENTICATED_METHODS: readonly MethodName[] = ['system.hello'];
