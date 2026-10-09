import { timingSafeEqual } from 'node:crypto';
import { platform } from 'node:os';
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from '@lgdm/protocol';
import { RpcError } from './errors.js';
import { BRIDGE_VERSION } from '../version.js';

export interface Session {
  authed: boolean;
  /** Push an unsolicited event to this client. */
  emit(event: string, data?: unknown): void;
}

export interface Context {
  token: string;
}

type Handler<M extends MethodName> = (
  params: ParamsOf<M>,
  session: Session,
  ctx: Context,
) => Promise<ResultOf<M>> | ResultOf<M>;

export type HandlerMap = { [M in MethodName]: Handler<M> };

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const handlers: HandlerMap = {
  'system.hello': (params, session, ctx) => {
    if (!tokensMatch(params.token, ctx.token)) {
      throw new RpcError(ErrorCodes.Unauthorized, 'Pairing token is not valid for this bridge.');
    }
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      throw new RpcError(
        'protocol_mismatch',
        `This bridge speaks protocol v${PROTOCOL_VERSION}, the web app speaks v${params.protocolVersion}. Update whichever is older.`,
      );
    }
    session.authed = true;
    return { protocolVersion: PROTOCOL_VERSION, bridgeVersion: BRIDGE_VERSION, platform: platform() };
  },
  'system.ping': () => ({ now: Date.now() }),
};
