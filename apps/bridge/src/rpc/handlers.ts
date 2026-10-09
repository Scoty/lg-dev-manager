import { timingSafeEqual } from 'node:crypto';
import { platform } from 'node:os';
import {
  ErrorCodes,
  OP_PROGRESS_EVENT,
  PROTOCOL_VERSION,
  type MethodName,
  type OpProgress,
  type ParamsOf,
  type ResultOf,
} from '@lgdm/protocol';
import { RpcError } from './errors.js';
import { BRIDGE_VERSION } from '../version.js';
import type { SshPool } from '../ssh/pool.js';
import { lunaCall } from '../ssh/luna.js';
import { verifyKey } from '../devices/keys.js';
import { fetchKey } from '../devices/keyserver.js';
import { checkConnection } from '../devices/ports.js';
import { deviceInfo, generateKey, storageInfo } from '../devices/info.js';
import { appIcon, installIpk, launchApp, listApps, removeApp } from '../apps/apps.js';
import type { UploadStore } from './uploads.js';

export interface Session {
  authed: boolean;
  /** Push an unsolicited event to this client. */
  emit(event: string, data?: unknown): void;
  /** Files this client has sent, held in memory until used or the connection closes. */
  uploads: UploadStore;
}

/** Progress reporter for one operation, sent as `op.progress` events. */
const progressFor = (session: Session, opId: string) => (p: Omit<OpProgress, 'opId'>) =>
  session.emit(OP_PROGRESS_EVENT, { opId, ...p } satisfies OpProgress);

export interface Context {
  token: string;
  pool: SshPool;
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

  'device.checkConnection': ({ host }) => checkConnection(host),

  'device.fetchKey': async ({ host, passphrase }) => {
    const privateKey = await fetchKey(host);
    const { fingerprint } = verifyKey(privateKey, passphrase);
    return { privateKey, fingerprint };
  },

  'device.verifyKey': ({ privateKey, passphrase }) => verifyKey(privateKey, passphrase),

  'device.test': async ({ device }, _s, { pool }) => {
    const started = Date.now();
    const res = await pool.exec(device, 'id -u', { timeoutMs: 20_000 });
    return { latencyMs: Date.now() - started, root: res.stdout.trim() === '0' };
  },

  'device.info': ({ device }, _s, { pool }) => deviceInfo(pool, device),
  'device.storage': ({ device }, _s, { pool }) => storageInfo(pool, device),
  'device.generateKey': ({ comment }) => generateKey(comment),

  'device.disconnect': ({ device }, _s, { pool }) => ({ closed: pool.close(device) }),

  'cmd.exec': ({ device, command, stdin, timeoutMs }, _s, { pool }) => pool.exec(device, command, { stdin, timeoutMs }),

  'luna.call': ({ device, uri, params, public: pub, falseAsError }, _s, { pool }) =>
    lunaCall(pool, device, uri, params ?? {}, pub ?? true, falseAsError ?? true),

  'apps.list': async ({ device }, _s, { pool }) => ({ apps: await listApps(pool, device) }),
  'apps.launch': async ({ device, id, params }, _s, { pool }) => {
    await launchApp(pool, device, id, params);
    return {};
  },
  'apps.icon': ({ device, path }, _s, { pool }) => appIcon(pool, device, path),
  'apps.remove': async ({ device, id, opId }, session, { pool }) => {
    await removeApp(pool, device, id, progressFor(session, opId));
    return {};
  },
  'apps.install': async ({ device, uploadId, opId }, session, { pool }) => {
    const { name, data, done } = session.uploads.take(uploadId);
    try {
      return await installIpk(pool, device, name, data, progressFor(session, opId));
    } finally {
      done();
    }
  },

  'upload.begin': ({ name, size }, session) => ({ uploadId: session.uploads.begin(name, size) }),
  'upload.chunk': ({ uploadId, offset, data }, session) => ({ received: session.uploads.chunk(uploadId, offset, data) }),
  'upload.discard': ({ uploadId }, session) => {
    session.uploads.discard(uploadId);
    return {};
  },
};
