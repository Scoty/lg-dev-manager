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

interface Entry {
  client: Client;
  ready: Promise<Client>;
  idle?: ReturnType<typeof setTimeout>;
  busy: number;
  /** SFTP session, opened on first use. Resolves to null when the TV has no SFTP subsystem. */
  sftp?: Promise<SFTPWrapper | null>;
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

/** A running command whose output is consumed as it arrives (e.g. a luna subscription). */
export interface Channel {
  stream: ClientChannel;
  /** Close the channel and return the connection to the pool. Safe to call more than once. */
  close(): void;
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
export class SshPool {
  private entries = new Map<string, Entry>();

  constructor(private readonly idleMs = IDLE_MS) {}

  get size() {
    return this.entries.size;
  }

  private connect(t: DeviceTarget): Entry {
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

    const client = new Client();
    const key = keyOf(t);
    const ready = new Promise<Client>((resolve, reject) => {
      client.once('ready', () => resolve(client));
      client.once('error', (e) => {
        if (this.entries.get(key)?.client === client) this.entries.delete(key);
        reject(mapConnectError(e, t));
      });
      if (t.auth.kind === 'password') {
        const pw = t.auth.password;
        client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pw)));
      }
    });
    client.on('close', () => {
      if (this.entries.get(key)?.client === client) this.entries.delete(key);
    });
    client.on('error', () => {}); // later errors surface on the in-flight operation / close
    client.connect(config);
    return { client, ready, busy: 0 };
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
  async acquire(t: DeviceTarget): Promise<{ client: Client; release: () => void }> {
    const e = this.entryFor(t);
    clearTimeout(e.idle);
    e.busy++;
    let released = false;
    try {
      const client = await e.ready;
      return {
        client,
        release: () => {
          if (released) return;
          released = true;
          e.busy--;
          if (e.busy === 0) e.idle = setTimeout(() => this.close(t), this.idleMs);
        },
      };
    } catch (err) {
      e.busy--;
      throw err;
    }
  }

  /** Run a command and collect its output as bytes. */
  async execRaw(t: DeviceTarget, command: string, opts: ExecOptions = {}): Promise<RawExecResult> {
    const { client, release } = await this.acquire(t);
    const limit = opts.maxOutput ?? MAX_OUTPUT;
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
            reject(new RpcError(DeviceErrorCodes.Timeout, `Command timed out after ${opts.timeoutMs ?? 120_000} ms.`));
          }, opts.timeoutMs ?? 120_000);
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
          if (opts.stdin !== undefined) stream.end(opts.stdin);
          else stream.end();
        });
      });
    } finally {
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
    const { client, release } = await this.acquire(t);
    try {
      const stream = await new Promise<ClientChannel>((resolve, reject) => {
        client.exec(command, (err, s) =>
          err ? reject(new RpcError(DeviceErrorCodes.CommandFailed, 'The TV did not accept the command.', err.message)) : resolve(s),
        );
      });
      stream.on('close', release);
      return {
        stream,
        close: () => {
          stream.close();
          release();
        },
      };
    } catch (e) {
      release();
      throw e;
    }
  }

  /**
   * The device's SFTP session, or null if it has none (some TVs only allow exec channels; callers then
   * stream files through `cat`, like ares-cli's FileTransfer).
   */
  async sftp(t: DeviceTarget): Promise<{ sftp: SFTPWrapper | null; release: () => void }> {
    const { client, release } = await this.acquire(t);
    const e = this.entryFor(t);
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

  /** Close the pooled connection for one device, or all of them. Returns how many were closed. */
  close(t?: DeviceTarget): number {
    const keys = t ? [keyOf(t)] : [...this.entries.keys()];
    let n = 0;
    for (const k of keys) {
      const e = this.entries.get(k);
      if (!e) continue;
      clearTimeout(e.idle);
      e.client.end();
      this.entries.delete(k);
      n++;
    }
    return n;
  }
}
