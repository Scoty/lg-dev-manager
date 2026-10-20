import {
  ErrorCodes,
  Methods,
  RpcRequest,
  UNAUTHENTICATED_METHODS,
  type MethodName,
  type RpcResponse,
  StoreErrorCodes,
} from '@lgdm/protocol';
import { RpcError } from './errors.js';
import { handlers, type Context, type Session } from './handlers.js';

const isMethod = (m: string): m is MethodName => Object.hasOwn(Methods, m);

/**
 * A call may name a TV the bridge stores ({ stored: id }, store.ts in the protocol) instead of carrying its login: put
 * the full target in its place before the call is checked and run. Without storage (no --store) that's refused.
 */
function resolveStoredDevice(params: unknown, ctx: Context): unknown {
  if (!params || typeof params !== 'object') return params;
  const device = (params as { device?: unknown }).device;
  if (!device || typeof device !== 'object' || !('stored' in device)) return params;
  if (!ctx.store) throw new RpcError(StoreErrorCodes.Off, 'This bridge doesn’t store TVs (start it with --store).');
  return { ...params, device: ctx.store.target(device) };
}

/** Parses one incoming frame and produces the response frame. Never throws. */
export async function dispatch(raw: string, session: Session, ctx: Context): Promise<RpcResponse | null> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null; // not even JSON — drop silently
  }
  const req = RpcRequest.safeParse(json);
  if (!req.success) return null;
  const { id, method } = req.data;

  try {
    if (!isMethod(method)) throw new RpcError(ErrorCodes.UnknownMethod, `Unknown method: ${method}`);
    if (!session.authed && !UNAUTHENTICATED_METHODS.includes(method)) {
      throw new RpcError(ErrorCodes.Unauthorized, 'Not paired. Send system.hello first.');
    }
    const parsed = Methods[method].params.safeParse(resolveStoredDevice(req.data.params, ctx));
    if (!parsed.success) {
      throw new RpcError(ErrorCodes.BadRequest, `Invalid parameters for ${method}`, parsed.error.message);
    }
    const handler = handlers[method] as (p: unknown, s: Session, c: Context) => unknown;
    const result = await handler(parsed.data, session, ctx);
    return { id, result };
  } catch (e) {
    if (e instanceof RpcError) return { id, error: e.toBody() };
    const err = e as Error;
    // The stack shows paths on this computer (home folder, user name): only for a bridge started with --dev.
    const detail = ctx.dev ? (err?.stack ?? String(e)) : (err?.message ?? String(e));
    return { id, error: { code: ErrorCodes.Internal, message: 'Unexpected bridge error.', detail } };
  }
}
