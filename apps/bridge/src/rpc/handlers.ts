import { timingSafeEqual } from 'node:crypto';
import { platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  CMD_LOG_EVENT,
  CMD_OUTPUT_EVENT,
  DeviceErrorCodes,
  ErrorCodes,
  LITEFIN_APP_ID,
  LOG_LINES_EVENT,
  type LogLines,
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
import { deviceInfo, generateKey, storageInfo, takeScreenshot } from '../devices/info.js';
import { DEFAULT_LGE_URL, devModeStatus, renewDevMode } from '../devices/devmode.js';
import { appIcon, hbChannelConfig, installDownloadable, installFromRepo, installIpk, launchApp, listApps, removeApp } from '../apps/apps.js';
import type { HttpTrace, RepoClient } from '../repo/repo.js';
import type { LitefinClient } from '../litefin/litefin.js';
import type { ShellSessions } from '../shell/shells.js';
import { homeDir, listDir, makeDir, readChunk, removePath, renameFile, statFile, writeFile } from '../files/files.js';
import type { UploadStore } from './uploads.js';
import { LineBatcher, clearLog, deleteCrashReport, enableDevLogs, listCrashReports, logCommand, pmLogSet, pmLogShow, readCrashReport, requireRoot } from '../debug/debug.js';

export interface Session {
  authed: boolean;
  /** Push an unsolicited event to this client. */
  emit(event: string, data?: unknown): void;
  /** Files this client has sent, held in memory until used or the connection closes. */
  uploads: UploadStore;
  /** Console commands this client is running (cmd.stream), by opId. Closed when the connection closes. */
  streams: Map<string, RunningCommand>;
  /** Interactive terminals (shell.*). Closed when the connection closes. */
  shells: ShellSessions;
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
async function traceHttp<T>(session: Session, target: string, command: string, fn: () => Promise<T>, quiet = false): Promise<T> {
  const id = randomUUID();
  const at = Date.now();
  const q = quiet ? { quiet: true } : {};
  session.emit(CMD_LOG_EVENT, { id, phase: 'start', target, command, kind: 'http', at, ...q } satisfies CmdLog);
  try {
    const r = await fn();
    session.emit(CMD_LOG_EVENT, { id, phase: 'end', target, command, kind: 'http', at: Date.now(), durationMs: Date.now() - at, exitCode: 0, ...q } satisfies CmdLog);
    return r;
  } catch (e) {
    session.emit(CMD_LOG_EVENT, { id, phase: 'end', target, command, kind: 'http', at: Date.now(), durationMs: Date.now() - at, error: (e as Error).message, ...q } satisfies CmdLog);
    throw e;
  }
}

/** Console tracing for the Homebrew repository's HTTP requests. */
const httpTraceFor = (session: Session, quiet = false): HttpTrace => (target, command, fn) => traceHttp(session, target, command, fn, quiet);

/** Progress reporter for one operation, sent as `op.progress` events. */
const progressFor = (session: Session, opId: string) => (p: Omit<OpProgress, 'opId'>) =>
  session.emit(OP_PROGRESS_EVENT, { opId, ...p } satisfies OpProgress);

export interface Context {
  token: string;
  pool: SshPool;
  repo: RepoClient;
  /** Litefin's GitHub releases (LGDM_LITEFIN_URL overrides, for tests). */
  litefin: LitefinClient;
  /** LG's Developer Mode session service (LGDM_LGE_URL overrides, for tests). */
  lgeUrl?: string;
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

  'device.info': ({ device, quiet }, session, ctx) => deviceInfo(sshFor(session, ctx, quiet), device),
  'device.storage': ({ device, path }, session, ctx) => storageInfo(sshFor(session, ctx), device, path),
  'device.generateKey': ({ comment }) => generateKey(comment),
  // The token is read through the plain pool so it never appears in the console; the LG request is traced
  // with the token blanked out.
  'devmode.status': ({ device }, session, ctx) => devModeStatus(ctx.pool, device, ctx.lgeUrl ?? DEFAULT_LGE_URL, httpTraceFor(session)),
  'devmode.renew': async ({ device }, session, ctx) => {
    await renewDevMode(sshFor(session, ctx), device);
    return {};
  },
  'device.screenshot': ({ device, method }, session, ctx) => takeScreenshot(sshFor(session, ctx), device, method ?? 'DISPLAY'),
  'device.hbchannel': ({ device, quiet }, session, ctx) => hbChannelConfig(sshFor(session, ctx, quiet), device),

  // Graceful: the same TV may be busy for another page or tab of this browser.
  'device.disconnect': ({ device }, _s, { pool }) => ({ closed: pool.close(device, { graceful: true }) }),

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
  'logs.stream': async ({ device, source, opId, lines }, session, ctx) => {
    requireRoot(device, source === 'lsmonitor' ? 'The luna monitor' : source === 'dmesg' ? 'dmesg' : 'The system log');
    if (session.streams.has(opId)) throw new RpcError(ErrorCodes.BadRequest, 'That operation id is already running.');
    const run: RunningCommand = {
      cancelled: false,
      cancel() {
        this.cancelled = true;
        this.ch?.close();
      },
    };
    // Stopping answers at once, even if the TV is slow to confirm the channel closed (or has gone offline).
    let onCancel: () => void = () => {};
    const cancelled = new Promise<null>((resolve) => (onCancel = () => resolve(null)));
    const cancel = run.cancel.bind(run);
    run.cancel = () => {
      cancel();
      onCancel();
    };
    session.streams.set(opId, run);
    const batch = new LineBatcher(
      (l, dropped) => session.emit(LOG_LINES_EVENT, { opId, lines: l, ...(dropped ? { dropped } : {}) } satisfies LogLines),
      // ls-monitor prints one JSON message per line, some of them large; cut lines would be unreadable.
      source === 'lsmonitor' ? 1024 * 1024 : undefined,
    );
    try {
      const ssh = sshFor(session, ctx);
      if (source === 'syslog') await enableDevLogs(ssh, device);
      if (run.cancelled) return { exitCode: null, stopped: true };
      const ch = await ssh.open(device, logCommand(source, lines ?? 100));
      run.ch = ch;
      const stderr: Buffer[] = [];
      ch.stream.on('data', (c: Buffer) => batch.push(c));
      ch.stream.stderr.on('data', (c: Buffer) => stderr.length < 64 && stderr.push(c));
      const exit = new Promise<number | null>((resolve) => ch.stream.on('close', (code: number | null) => resolve(typeof code === 'number' ? code : null)));
      if (run.cancelled) ch.close();
      const exitCode = await Promise.race([exit, cancelled]);
      batch.flush(true);
      if (!run.cancelled && exitCode !== 0 && !batch.sawOutput) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        throw new RpcError(DeviceErrorCodes.CommandFailed, /denied|not permitted/i.test(detail) ? 'The TV refused to show this log.' : 'Couldn’t read this log on the TV.', detail);
      }
      return { exitCode: run.cancelled ? null : exitCode, stopped: run.cancelled };
    } finally {
      batch.stop();
      session.streams.delete(opId);
      run.ch?.close();
    }
  },
  'logs.stop': ({ opId }, session) => {
    const run = session.streams.get(opId);
    if (!run) return { stopped: false };
    run.cancel();
    return { stopped: true };
  },
  'logs.clear': async ({ device, source }, session, ctx) => (await clearLog(sshFor(session, ctx), device, source), {}),
  'pmlog.show': async ({ device }, session, ctx) => ({ contexts: await pmLogShow(sshFor(session, ctx), device) }),
  'pmlog.set': async ({ device, context, level }, session, ctx) => ({ changed: await pmLogSet(sshFor(session, ctx), device, context, level) }),
  'crashes.list': ({ device }, session, ctx) => listCrashReports(sshFor(session, ctx), device),
  'crashes.read': ({ device, path }, session, ctx) => readCrashReport(sshFor(session, ctx), device, path),
  'crashes.delete': async ({ device, path }, session, ctx) => (await deleteCrashReport(sshFor(session, ctx), device, path), {}),
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

  'apps.installFromRepo': ({ device, id, channel, opId }, session, ctx) =>
    installFromRepo(sshFor(session, ctx), ctx.repo, device, id, channel ?? 'stable', progressFor(session, opId), httpTraceFor(session)),

  'litefin.list': (params, session, { litefin }) => litefin.list({ refresh: params?.refresh, trace: httpTraceFor(session) }),
  'litefin.install': async ({ device, tag, variant, opId }, session, ctx) => {
    const progress = progressFor(session, opId);
    const trace = httpTraceFor(session);
    const { release, asset, url, fetch } = await ctx.litefin.download(tag, variant, progress, trace);
    return installDownloadable(
      sshFor(session, ctx),
      device,
      { id: LITEFIN_APP_ID, title: `Litefin ${release.version} (${asset.variant.replace(/-/g, ' ')})`, version: release.version, ipkUrl: url, sha256: asset.sha256 },
      fetch,
      progress,
    );
  },

  'repo.list': ({ refresh }, session, { repo }) => repo.list({ refresh, trace: httpTraceFor(session, true) }),
  'repo.image': ({ url }, session, { repo }) => repo.image(url, httpTraceFor(session, true)),
  'repo.description': ({ id }, session, { repo }) => repo.description(id, httpTraceFor(session, true)),

  'files.home': async ({ device }, session, ctx) => ({ path: await homeDir(sshFor(session, ctx), device) }),
  'files.list': ({ device, path }, session, ctx) => listDir(sshFor(session, ctx), device, path),
  'files.stat': ({ device, path }, session, ctx) => statFile(sshFor(session, ctx), device, path),
  'files.read': async ({ device, path, offset, length }, session, ctx) => {
    const { data, eof } = await readChunk(sshFor(session, ctx, true), device, path, offset, length);
    return { data: data.toString('base64'), eof };
  },
  'files.write': async ({ device, path, uploadId, opId, overwrite }, session, ctx) => {
    const { data, done } = session.uploads.take(uploadId);
    const progress = progressFor(session, opId);
    try {
      let last = -1;
      return await writeFile(sshFor(session, ctx), device, path, data, !!overwrite, (sent) => {
        const pct = Math.floor((sent / Math.max(1, data.length)) * 100);
        if (pct !== last) {
          last = pct;
          progress({ stage: 'upload', percent: pct, text: 'Copying to the TV…' });
        }
      });
    } finally {
      done();
    }
  },
  'files.mkdir': ({ device, parent, name }, session, ctx) => makeDir(sshFor(session, ctx), device, parent, name),
  'files.rename': ({ device, parent, from, to }, session, ctx) => renameFile(sshFor(session, ctx), device, parent, from, to),
  'files.remove': async ({ device, path }, session, ctx) => {
    await removePath(sshFor(session, ctx), device, path);
    return {};
  },

  'shell.open': ({ device, rows, cols, pty }, session) => session.shells.open(device, rows, cols, pty ?? true),
  'shell.write': ({ shellId, data }, session) => {
    session.shells.write(shellId, data);
    return {};
  },
  'shell.resize': ({ shellId, rows, cols }, session) => {
    session.shells.resize(shellId, rows, cols);
    return {};
  },
  'shell.ack': ({ shellId, bytes }, session) => {
    session.shells.ack(shellId, bytes);
    return {};
  },
  'shell.close': ({ shellId }, session) => {
    session.shells.close(shellId);
    return {};
  },

  'upload.begin': ({ name, size }, session) => ({ uploadId: session.uploads.begin(name, size) }),
  'upload.chunk': ({ uploadId, offset, data }, session) => ({ received: session.uploads.chunk(uploadId, offset, data) }),
  'upload.discard': ({ uploadId }, session) => {
    session.uploads.discard(uploadId);
    return {};
  },
};
