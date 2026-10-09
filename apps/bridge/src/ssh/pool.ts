import { createHash } from 'node:crypto';
import ssh2, { type Client as ClientType, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { DeviceErrorCodes, type DeviceTarget } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { verifyKey } from '../devices/keys.js';

// ssh2 is CommonJS: named runtime imports break under native Node ESM, so destructure the default export.
const { Client } = ssh2;
type Client = ClientType;

const IDLE_MS = 120_000;
const READY_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 32 * 1024 * 1024;
/**
 * Exec channels open at once per connection. sshd limits sessions per connection (OpenSSH MaxSessions is 10),
 * and a page full of app icons would otherwise open dozens of `cat` channels on TVs without SFTP.
 */
const MAX_CHANNELS = 6;
/**
 * Long-lived channels (followed logs, console commands, installs that wait for the TV) get their own few slots, so
 * they can never use up the exec channels every other page needs. More than this run on a connection of their own.
 * 6 + 3 (+ SFTP) stays under OpenSSH's MaxSessions of 10.
 */
const MAX_STREAMS = 3;

interface Entry {
  key: string;
  client: Client;
  ready: Promise<Client>;
  idle?: ReturnType<typeof setTimeout>;
  busy: number;
  /** SFTP session, opened on first use. Resolves to null when the TV has no SFTP subsystem. */
  sftp?: Promise<SFTPWrapper | null>;
  /** Exec channels in use, and callers waiting for one. */
  channels: number;
  waiting: (() => void)[];
  /** Long-lived channels (`open`) on this connection. */
  streams: number;
  /** Forgotten by `close({ graceful })`: end the connection once its running commands finish. */
  closing?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RawExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

export interface ExecOptions {
  /** Sent to the command's stdin, then stdin is closed. */
  stdin?: string | Buffer;
  timeoutMs?: number;
  /** Stop reading (and fail) once stdout+stderr exceed this many bytes. */
  maxOutput?: number;
}

export type TraceKind = 'sftp' | 'tunnel' | 'http';

/**
 * What the SSH helpers need. `SshPool` is the shared implementation; `LoggedSsh` wraps it per client so the
 * client's console sees every command.
 */
export interface SshRunner {
  acquire(t: DeviceTarget): Promise<{ client: Client; release: () => void }>;
  execRaw(t: DeviceTarget, command: string, opts?: ExecOptions): Promise<RawExecResult>;
  exec(t: DeviceTarget, command: string, opts?: ExecOptions): Promise<ExecResult>;
  open(t: DeviceTarget, command: string): Promise<Channel>;
  sftp(t: DeviceTarget): Promise<{ sftp: SFTPWrapper | null; release: () => void }>;
  /** Report a non-exec operation (file transfer, tunnel) around `fn`. */
  traceOp<T>(t: DeviceTarget, kind: TraceKind, label: string, fn: () => Promise<T>): Promise<T>;
}

/** A running command whose output is consumed as it arrives (e.g. a luna subscription). */
export interface Channel {
  stream: ClientChannel;
  /** Close the channel and return the connection to the pool. Safe to call more than once. */
  close(): void;
}

function configFor(t: DeviceTarget): ConnectConfig {
  const config: ConnectConfig = {
    host: t.host.replace(/^\[|\]$/g, ''),
    port: t.port,
    username: t.username,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: 15_000,
    tryKeyboard: t.auth.kind === 'password',
  };
  if (t.auth.kind === 'key') {
    verifyKey(t.auth.privateKey, t.auth.passphrase); // throws passphrase_required / bad_passphrase early
    config.privateKey = t.auth.privateKey;
    if (t.auth.passphrase) config.passphrase = t.auth.passphrase;
  } else {
    config.password = t.auth.password;
  }
  return config;
}

/** Stable pool key. Hashing keeps credentials out of any map keys that might be logged. */
function keyOf(t: DeviceTarget): string {
  return createHash('sha256').update(JSON.stringify([t.host, t.port, t.username, t.auth])).digest('hex');
}

function mapConnectError(e: Error & { level?: string; code?: string }, t: DeviceTarget): RpcError {
  const where = `${t.username}@${t.host}:${t.port}`;
  if (e.level === 'client-authentication') {
    return new RpcError(DeviceErrorCodes.AuthFailed, `The TV refused the login for ${where}. Check the key or password.`);
  }
  if (/handshake/i.test(e.message) || e.code === 'ETIMEDOUT') {
    return new RpcError(DeviceErrorCodes.Timeout, `Timed out connecting to ${where}.`, e.message);
  }
  return new RpcError(
    DeviceErrorCodes.Unreachable,
    `Could not connect to ${where}. Is the TV on, and is Developer Mode / SSH enabled?`,
    e.code ?? e.message,
  );
}

/**
 * Keeps one SSH connection per device open for a while so repeated calls are fast.
 * Credentials live only in memory, inside the ssh2 client, for as long as the connection is pooled.
 */
export class SshPool implements SshRunner {
  private entries = new Map<string, Entry>();

  constructor(private readonly idleMs = IDLE_MS) {}

  get size() {
    return this.entries.size;
  }

  private connect(t: DeviceTarget): Entry {
    const config = configFor(t);
    const client = new Client();
    const key = keyOf(t);
    const ready = new Promise<Client>((resolve, reject) => {
      client.once('ready', () => {
        // Small request/response traffic: without this, Nagle + delayed ACKs add up to ~200 ms per command
        // (macOS). OpenSSH sets TCP_NODELAY for the same reason.
        client.setNoDelay(true);
        resolve(client);
      });
      client.once('error', (e) => {
        this.forget(entry);
        reject(mapConnectError(e, t));
      });
      if (t.auth.kind === 'password') {
        const pw = t.auth.password;
        client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pw)));
      }
    });
    const entry: Entry = { key, client, ready, busy: 0, channels: 0, waiting: [], streams: 0 };
    client.on('close', () => this.forget(entry));
    client.on('error', () => {}); // later errors surface on the in-flight operation / close
    client.connect(config);
    return entry;
  }

  /** Drop an entry from the pool (only if it is still the current one for its key) and stop its timer. */
  private forget(e: Entry) {
    clearTimeout(e.idle);
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
  }

  /**
   * Wait for a free exec channel on this connection, at most `timeoutMs` (a command the user has given up on must
   * not run later). Returns the function that frees it.
   */
  private async channel(e: Entry, timeoutMs: number): Promise<() => void> {
    if (e.channels >= MAX_CHANNELS) {
      await new Promise<void>((resolve, reject) => {
        const turn = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const i = e.waiting.indexOf(turn);
          if (i >= 0) e.waiting.splice(i, 1);
          reject(new RpcError(DeviceErrorCodes.Timeout, 'The TV is busy with other commands. Try again in a moment.'));
        }, timeoutMs);
        e.waiting.push(turn);
      });
    }
    e.channels++;
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      e.channels--;
      e.waiting.shift()?.();
    };
  }

  private entryFor(t: DeviceTarget): Entry {
    const key = keyOf(t);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.connect(t);
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Get a ready client for a device and mark it busy until `release` is called. */
  async acquire(t: DeviceTarget): Promise<{ client: Client; entry: Entry; release: () => void }> {
    const e = this.entryFor(t);
    clearTimeout(e.idle);
    e.busy++;
    let released = false;
    try {
      const client = await e.ready;
      return {
        client,
        entry: e,
        release: () => {
          if (released) return;
          released = true;
          e.busy--;
          if (e.busy === 0 && e.closing) {
            e.client.end();
          } else if (e.busy === 0 && this.entries.get(e.key) === e) {
            clearTimeout(e.idle);
            // The timer only ever closes this same entry, and only if nobody picked it up again meanwhile.
            e.idle = setTimeout(() => {
              if (e.busy === 0 && this.entries.get(e.key) === e) {
                this.forget(e);
                e.client.end();
              }
            }, this.idleMs);
          }
        },
      };
    } catch (err) {
      e.busy--;
      throw err;
    }
  }

  /** Run a command and collect its output as bytes. */
  async execRaw(t: DeviceTarget, command: string, opts: ExecOptions = {}): Promise<RawExecResult> {
    const { client, entry, release } = await this.acquire(t);
    const limit = opts.maxOutput ?? MAX_OUTPUT;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const queued = Date.now();
    let freeChannel: () => void;
    try {
      freeChannel = await this.channel(entry, timeoutMs);
    } catch (e) {
      release();
      throw e;
    }
    // Time spent waiting for a channel counts towards the command's timeout.
    const remaining = Math.max(1_000, timeoutMs - (Date.now() - queued));
    try {
      return await new Promise<RawExecResult>((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) {
            reject(new RpcError(DeviceErrorCodes.CommandFailed, 'The TV did not accept the command.', err.message));
            return;
          }
          const out: Buffer[] = [];
          const errOut: Buffer[] = [];
          let size = 0;
          let overflow = false;
          const timer = setTimeout(() => {
            stream.close();
            reject(new RpcError(DeviceErrorCodes.Timeout, `Command timed out after ${timeoutMs} ms.`));
          }, remaining);
          const push = (arr: Buffer[]) => (c: Buffer) => {
            size += c.length;
            if (size > limit) {
              overflow = true;
              stream.close();
              return;
            }
            arr.push(c);
          };
          stream.on('data', push(out));
          stream.stderr.on('data', push(errOut));
          stream.on('close', (code: number | null) => {
            clearTimeout(timer);
            if (overflow) {
              reject(new RpcError(DeviceErrorCodes.CommandFailed, `The command printed more than ${limit} bytes.`));
              return;
            }
            resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(errOut), exitCode: typeof code === 'number' ? code : null });
          });
          // Only close stdin when we have input to send (like dev-manager-desktop's execute_command). Some
          // commands watch stdin and quit on EOF — luna-send exits silently before the TV has answered.
          if (opts.stdin !== undefined) stream.end(opts.stdin);
        });
      });
    } finally {
      freeChannel();
      release();
    }
  }

  /** Run a command and collect its output as UTF-8 text. */
  async exec(t: DeviceTarget, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const r = await this.execRaw(t, command, opts);
    return { stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), exitCode: r.exitCode };
  }

  /**
   * Start a command and hand back its live channel. The connection stays busy (not idle-closed)
   * until `close()` is called or the command ends.
   */
  async open(t: DeviceTarget, command: string): Promise<Channel> {
    const { client, entry, release } = await this.acquire(t);
    if (entry.streams >= MAX_STREAMS) {
      // All stream slots taken (three logs followed in other tabs…): this one gets a connection of its own.
      release();
      const own = await this.dedicated(t);
      try {
        const ch = await this.execChannel(own, command);
        ch.stream.on('close', () => own.end());
        return { stream: ch.stream, close: () => (ch.close(), own.end()) };
      } catch (e) {
        own.end();
        throw e;
      }
    }
    entry.streams++;
    let freed = false;
    const done = () => {
      if (freed) return;
      freed = true;
      entry.streams--;
      release();
    };
    try {
      const ch = await this.execChannel(client, command);
      ch.stream.on('close', done);
      return {
        stream: ch.stream,
        close: () => {
          ch.close();
          done();
        },
      };
    } catch (e) {
      done();
      throw e;
    }
  }

  private async execChannel(client: Client, command: string): Promise<{ stream: ClientChannel; close: () => void }> {
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec(command, (err, s) =>
        err ? reject(new RpcError(DeviceErrorCodes.CommandFailed, 'The TV did not accept the command.', err.message)) : resolve(s),
      );
    });
    return { stream, close: () => stream.close() };
  }

  /**
   * The device's SFTP session, or null if it has none (some TVs only allow exec channels; callers then
   * stream files through `cat`, like ares-cli's FileTransfer).
   */
  async sftp(t: DeviceTarget): Promise<{ sftp: SFTPWrapper | null; release: () => void }> {
    const { client, entry: e, release } = await this.acquire(t);
    e.sftp ??= new Promise<SFTPWrapper | null>((resolve) => {
      client.sftp((err, s) => {
        if (err || !s) return resolve(null);
        s.on('close', () => {
          if (e.sftp) e.sftp = undefined;
        });
        resolve(s);
      });
    });
    return { sftp: await e.sftp, release };
  }

  traceOp<T>(_t: DeviceTarget, _kind: TraceKind, _label: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /**
   * A connection of its own, outside the pool — for long-lived interactive shells, which the original also runs on
   * separate connections (shell_manager/shell.rs) so they never compete with commands for channels or idle out.
   * The caller ends it.
   */
  async dedicated(t: DeviceTarget): Promise<Client> {
    const config = configFor(t);
    const client = new Client();
    return new Promise<Client>((resolve, reject) => {
      client.once('ready', () => {
        client.setNoDelay(true);
        client.removeAllListeners('error');
        client.on('error', () => {}); // surfaces as 'close' on the shell
        resolve(client);
      });
      client.once('error', (e) => reject(mapConnectError(e, t)));
      if (t.auth.kind === 'password') {
        const pw = t.auth.password;
        client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pw)));
      }
      client.connect(config);
    });
  }

  /** Close the pooled connection for one device, or all of them. Returns how many were closed. */
  /**
   * Forget pooled connections (all, or one device's). New calls connect afresh. `graceful`: a connection that is
   * still running commands (another page, another tab) is ended when they finish instead of cutting them off.
   */
  close(t?: DeviceTarget, { graceful = false }: { graceful?: boolean } = {}): number {
    const keys = t ? [keyOf(t)] : [...this.entries.keys()];
    let n = 0;
    for (const k of keys) {
      const e = this.entries.get(k);
      if (!e) continue;
      this.forget(e);
      if (graceful && e.busy > 0) e.closing = true;
      else e.client.end();
      n++;
    }
    return n;
  }
}
