import { z } from 'zod';
import {
  DeviceTarget,
  ErrorCodes,
  Methods,
  RpcRequest,
  UNAUTHENTICATED_METHODS,
  type MethodName,
  type RpcResponse,
  StoreErrorCodes,
  StoredDeviceRef,
} from '@lgdm/protocol';
import { RpcError } from './errors.js';
import { handlers, type Context, type Session } from './handlers.js';

const isMethod = (m: string): m is MethodName => Object.hasOwn(Methods, m);

/** Methods whose `device` is a TV to connect to (a DeviceTarget): only these take a stored TV ({ stored: id }). */
const TAKES_TARGET = new Set(
  (Object.keys(Methods) as MethodName[]).filter((m) => {
    const schema = Methods[m].params as unknown;
    if (!(schema instanceof z.ZodObject)) return false;
    let device = (schema.shape as Record<string, unknown>).device;
    if (device instanceof z.ZodOptional) device = device.unwrap();
    return device === DeviceTarget;
  }),
);

/** Stands in for a stored TV while the call's parameters are checked: the login is put in only afterwards. */
const PLACEHOLDER: DeviceTarget = { host: '192.0.2.1', port: 22, username: 'root', auth: { kind: 'password', password: 'x' } };

/**
 * A call may name a TV the bridge stores ({ stored: id }, store.ts in the protocol) instead of carrying its login. The
 * parameters are checked with a placeholder in its place, and the stored address and login go in only after that, so
 * an error about the parameters can never quote them. Without storage (no --store) a stored TV is refused.
 */
function storedRef(method: MethodName, params: unknown, ctx: Context): StoredDeviceRef | undefined {
  if (!TAKES_TARGET.has(method) || !params || typeof params !== 'object') return undefined;
  const device = (params as { device?: unknown }).device;
  if (!device || typeof device !== 'object' || !('stored' in device)) return undefined;
  if (!ctx.store) throw new RpcError(StoreErrorCodes.Off, 'This bridge doesn’t store TVs (start it with --store).');
  const ref = StoredDeviceRef.safeParse(device);
  if (!ref.success) throw new RpcError(ErrorCodes.BadRequest, 'Not a stored TV reference.');
  return ref.data;
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
    // After the pairing check: an unpaired browser learns nothing about what's stored.
    const stored = storedRef(method, req.data.params, ctx);
    const params = stored ? { ...(req.data.params as object), device: PLACEHOLDER } : req.data.params;
    const parsed = Methods[method].params.safeParse(params);
    if (!parsed.success) {
      throw new RpcError(ErrorCodes.BadRequest, `Invalid parameters for ${method}`, parsed.error.message);
    }
    if (stored) (parsed.data as { device: DeviceTarget }).device = ctx.store!.target(stored);
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
