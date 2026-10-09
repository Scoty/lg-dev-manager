import { createHash } from 'node:crypto';
import ssh2, { type Client as ClientType, type ConnectConfig } from 'ssh2';

// ssh2 is CommonJS: named runtime imports break under native Node ESM, so destructure the default export.
const { Client } = ssh2;
type Client = ClientType;
import { DeviceErrorCodes, type DeviceTarget } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { verifyKey } from '../devices/keys.js';

const IDLE_MS = 120_000;
const READY_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 32 * 1024 * 1024;

interface Entry {
  client: Client;
  ready: Promise<Client>;
  idle?: ReturnType<typeof setTimeout>;
  busy: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
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
        this.entries.delete(key);
        reject(mapConnectError(e, t));
      });
      if (t.auth.kind === 'password') {
        const pw = t.auth.password;
        client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pw)));
      }
    });
    client.on('close', () => this.entries.delete(key));
    client.on('error', () => {}); // later errors surface on the in-flight operation / close
    client.connect(config);
    return { client, ready, busy: 0 };
  }

  /** Get a ready client for a device and mark it busy until `release` is called. */
  async acquire(t: DeviceTarget): Promise<{ client: Client; release: () => void }> {
    const key = keyOf(t);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.connect(t);
      this.entries.set(key, entry);
    }
    clearTimeout(entry.idle);
    entry.busy++;
    const e = entry;
    try {
      const client = await e.ready;
      return {
        client,
        release: () => {
          e.busy--;
          if (e.busy === 0) e.idle = setTimeout(() => this.close(t), this.idleMs);
        },
      };
    } catch (err) {
      e.busy--;
      throw err;
    }
  }

  async exec(t: DeviceTarget, command: string, opts: { stdin?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    const { client, release } = await this.acquire(t);
    try {
      return await new Promise<ExecResult>((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) {
            reject(new RpcError(DeviceErrorCodes.CommandFailed, 'The TV did not accept the command.', err.message));
            return;
          }
          const out: Buffer[] = [];
          const errOut: Buffer[] = [];
          let size = 0;
          const timer = setTimeout(() => {
            stream.close();
            reject(new RpcError(DeviceErrorCodes.Timeout, `Command timed out after ${opts.timeoutMs} ms.`));
          }, opts.timeoutMs ?? 120_000);
          const push = (arr: Buffer[]) => (c: Buffer) => {
            size += c.length;
            if (size > MAX_OUTPUT) {
              stream.close();
              return;
            }
            arr.push(c);
          };
          stream.on('data', push(out));
          stream.stderr.on('data', push(errOut));
          stream.on('close', (code: number | null) => {
            clearTimeout(timer);
            resolve({
              stdout: Buffer.concat(out).toString('utf8'),
              stderr: Buffer.concat(errOut).toString('utf8'),
              exitCode: typeof code === 'number' ? code : null,
            });
          });
          if (opts.stdin !== undefined) stream.end(opts.stdin);
          else stream.end();
        });
      });
    } finally {
      release();
    }
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
