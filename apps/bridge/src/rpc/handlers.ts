import { timingSafeEqual } from 'node:crypto';
import { platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  CMD_LOG_EVENT,
  CMD_OUTPUT_EVENT,
  ErrorCodes,
  KEY_SERVER_PORT,
  OP_PROGRESS_EVENT,
  type CmdLog,
  type CmdOutput,
  PROTOCOL_VERSION,
  type MethodName,
  type OpProgress,
  type ParamsOf,
  type ResultOf,
} from '@lgdm/protocol';
import { RpcError } from './errors.js';
import { BRIDGE_VERSION } from '../version.js';
import type { Channel, SshPool } from '../ssh/pool.js';
import { LoggedSsh } from '../ssh/logged.js';
import { scanNetwork } from '../devices/scan.js';
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
  /** Console commands this client is running (cmd.stream), by opId. Closed when the connection closes. */
  streams: Map<string, RunningCommand>;
}

/** A console command; `cancel` may arrive before its channel has finished opening. */
export interface RunningCommand {
  ch?: Channel;
  cancelled: boolean;
  cancel(): void;
}

/** The SSH pool as this client sees it: everything it runs shows up in its console (`cmd.log`). */
const sshFor = (session: Session, ctx: Context, quiet = false) =>
  new LoggedSsh(ctx.pool, (e: CmdLog) => session.emit(CMD_LOG_EVENT, e), quiet);

/** Log a non-SSH step (the key server fetch) in the console. Output is never included. */
async function traceHttp<T>(session: Session, target: string, command: string, fn: () => Promise<T>): Promise<T> {
  const id = randomUUID();
  const at = Date.now();
  session.emit(CMD_LOG_EVENT, { id, phase: 'start', target, command, kind: 'http', at } satisfies CmdLog);
  try {
    const r = await fn();
    session.emit(CMD_LOG_EVENT, { id, phase: 'end', target, command, kind: 'http', at: Date.now(), durationMs: Date.now() - at, exitCode: 0 } satisfies CmdLog);
    return r;
  } catch (e) {
    session.emit(CMD_LOG_EVENT, { id, phase: 'end', target, command, kind: 'http', at: Date.now(), durationMs: Date.now() - at, error: (e as Error).message } satisfies CmdLog);
    throw e;
  }
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

  'device.scan': async (params) => ({ tvs: await scanNetwork({ timeoutMs: params?.timeoutMs }) }),

  'device.fetchKey': async ({ host, passphrase }, session) => {
    const privateKey = await traceHttp(session, `${host}:${KEY_SERVER_PORT}`, `GET http://${host}:${KEY_SERVER_PORT}/webos_rsa (Dev Mode key server)`, () =>
      fetchKey(host),
    );
    const { fingerprint } = verifyKey(privateKey, passphrase);
    return { privateKey, fingerprint };
  },

  'device.verifyKey': ({ privateKey, passphrase }) => verifyKey(privateKey, passphrase),

  'device.test': async ({ device }, session, ctx) => {
    const started = Date.now();
    const res = await sshFor(session, ctx).exec(device, 'id -u', { timeoutMs: 20_000 });
    return { latencyMs: Date.now() - started, root: res.stdout.trim() === '0' };
  },

  'device.info': ({ device }, session, ctx) => deviceInfo(sshFor(session, ctx), device),
  'device.storage': ({ device }, session, ctx) => storageInfo(sshFor(session, ctx), device),
  'device.generateKey': ({ comment }) => generateKey(comment),

  'device.disconnect': ({ device }, _s, { pool }) => ({ closed: pool.close(device) }),

  'cmd.exec': ({ device, command, stdin, timeoutMs }, session, ctx) => sshFor(session, ctx).exec(device, command, { stdin, timeoutMs }),

  'luna.call': ({ device, uri, params, public: pub, falseAsError }, session, ctx) =>
    lunaCall(sshFor(session, ctx), device, uri, params ?? {}, pub ?? true, falseAsError ?? true),

  'cmd.stream': async ({ device, command, opId }, session, { pool }) => {
    if (session.streams.has(opId)) throw new RpcError(ErrorCodes.BadRequest, 'That operation id is already running.');
    const run: RunningCommand = {
      cancelled: false,
      cancel() {
        this.cancelled = true;
        this.ch?.close();
      },
    };
    // Registered before the channel opens, so a quick Stop isn't lost.
    session.streams.set(opId, run);
    try {
      // Not logged as cmd.log: the console already shows the commands the user types, with live output.
      const ch = await pool.open(device, command);
      run.ch = ch;
      const send = (stream: CmdOutput['stream']) => (c: Buffer) =>
        session.emit(CMD_OUTPUT_EVENT, { opId, stream, data: c.toString('utf8') } satisfies CmdOutput);
      ch.stream.on('data', send('stdout'));
      ch.stream.stderr.on('data', send('stderr'));
      const exit = new Promise<number | null>((resolve) => ch.stream.on('close', (code: number | null) => resolve(typeof code === 'number' ? code : null)));
      // stdin stays open (luna-send quits on EOF); a command that waits for input runs until Stop.
      if (run.cancelled) ch.close();
      const exitCode = await exit;
      return { exitCode: run.cancelled ? null : exitCode, cancelled: run.cancelled };
    } finally {
      session.streams.delete(opId);
      run.ch?.close();
    }
  },
  'cmd.cancel': ({ opId }, session) => {
    const run = session.streams.get(opId);
    if (!run) return { cancelled: false };
    run.cancel();
    return { cancelled: true };
  },

  'apps.list': async ({ device }, session, ctx) => ({ apps: await listApps(sshFor(session, ctx), device) }),
  'apps.launch': async ({ device, id, params }, session, ctx) => {
    await launchApp(sshFor(session, ctx), device, id, params);
    return {};
  },
  'apps.icon': ({ device, path }, session, ctx) => appIcon(sshFor(session, ctx, true), device, path),
  'apps.remove': async ({ device, id, opId }, session, ctx) => {
    await removeApp(sshFor(session, ctx), device, id, progressFor(session, opId));
    return {};
  },
  'apps.install': async ({ device, uploadId, opId }, session, ctx) => {
    const { name, data, done } = session.uploads.take(uploadId);
    try {
      return await installIpk(sshFor(session, ctx), device, name, data, progressFor(session, opId));
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
