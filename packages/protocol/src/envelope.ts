import { z } from 'zod';

/**
 * Wire format between the web UI and the bridge (one JSON object per WebSocket text frame).
 *
 *   UI → bridge   { id, method, params }
 *   bridge → UI   { id, result }            on success
 *                 { id, error }             on failure
 *                 { event, data }           unsolicited (progress, streams, state changes)
 */

export const RpcRequest = z.object({
  id: z.number().int().nonnegative(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcErrorBody = z.object({
  /** Stable machine-readable code, e.g. `unauthorized`, `ssh_auth_failed`, `luna_error`. */
  code: z.string(),
  /** Human-readable, safe to show. Never contains secrets. */
  message: z.string(),
  /** Optional technical trace for the "details" expander. */
  detail: z.string().optional(),
});
export type RpcErrorBody = z.infer<typeof RpcErrorBody>;

export const RpcResponse = z.union([
  z.object({ id: z.number(), result: z.unknown() }),
  z.object({ id: z.number(), error: RpcErrorBody }),
]);
export type RpcResponse = z.infer<typeof RpcResponse>;

export const RpcEvent = z.object({
  event: z.string(),
  data: z.unknown().optional(),
});
export type RpcEvent = z.infer<typeof RpcEvent>;

export const ErrorCodes = {
  Unauthorized: 'unauthorized',
  BadRequest: 'bad_request',
  UnknownMethod: 'unknown_method',
  NotImplemented: 'not_implemented',
  Internal: 'internal',
} as const;
