import { randomUUID } from 'node:crypto';
import type { Client, ClientChannel } from 'ssh2';
import {
  CMD_LOG_EVENT,
  SHELL_EXIT_EVENT,
  SHELL_OUTPUT_EVENT,
  ShellErrorCodes,
  type CmdLog,
  type DeviceTarget,
  type ShellExit,
  type ShellOutput,
} from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import type { SshPool } from '../ssh/pool.js';

/**
 * Interactive shells for one WebSocket client (port of shell_manager in dev-manager-desktop, src-tauri/src/
 * shell_manager/shell.rs). Each shell has its own SSH connection; it asks for an "xterm" PTY and falls back to a
 * plain shell when the TV refuses one. Everything closes when the client disconnects. Keystrokes are never logged.
 *
 * Flow control: output the client hasn't acknowledged (`shell.ack`, sent once the terminal has drawn it) is
 * capped; past the cap the SSH channel is paused, so `yes` or `cat /dev/urandom` can't flood the bridge or the
 * browser.
 */

const MAX_SHELLS = 8;
/** Output is gathered for this long before it is sent, so a burst becomes one message instead of hundreds. */
const FLUSH_MS = 8;
const FLUSH_BYTES = 64 * 1024;
/** Pause the shell when this much output is unacknowledged; resume below LOW. */
const ACK_HIGH = 1024 * 1024;
const ACK_LOW = 256 * 1024;
/** Opening the session channel (PTY request, shell) must finish within this, well inside the client's 40 s. */
const CHANNEL_TIMEOUT_MS = 20_000;

interface Shell {
  id: string;
  client: Client;
  stream: ClientChannel;
  pty: boolean;
  exited: boolean;
  unacked: number;
  paused: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new RpcError(ShellErrorCodes.Failed, `The TV didn’t ${what} in time.`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export class ShellSessions {
  private shells = new Map<string, Shell>();
  private pending = 0;
  /** Set when the WebSocket has closed: shells still being opened are ended instead of kept. */
  private closed = false;

  constructor(
    private readonly pool: SshPool,
    private readonly emit: (event: string, data: unknown) => void,
  ) {}

  get count() {
    return this.shells.size;
  }

  async open(device: DeviceTarget, rows: number, cols: number, wantPty = true): Promise<{ shellId: string; pty: boolean; title: string }> {
    if (this.closed) throw new RpcError(ShellErrorCodes.Failed, 'This connection is closing.');
    if (this.shells.size + this.pending >= MAX_SHELLS) {
      throw new RpcError(ShellErrorCodes.TooMany, `At most ${MAX_SHELLS} terminals can be open at once. Close one first.`);
    }
    this.pending++;
    const target = `${device.username}@${device.host}:${device.port}`;
    const logId = randomUUID();
    const started = Date.now();
    let client: Client | undefined;
    const ensureOpen = () => {
      if (this.closed) throw new RpcError(ShellErrorCodes.Failed, 'The connection closed while the terminal was opening.');
    };
    try {
      client = await this.pool.dedicated(device);
      ensureOpen();
      const c = client;
      const shellOn = (window: false | { term: string; rows: number; cols: number }) =>
        withTimeout(
          new Promise<ClientChannel>((resolve, reject) => c.shell(window, (err, s) => (err ? reject(err) : resolve(s)))),
          CHANNEL_TIMEOUT_MS,
          'start a shell',
        );
      let stream: ClientChannel;
      let pty = wantPty;
      if (wantPty) {
        try {
          stream = await shellOn({ term: 'xterm', rows, cols });
        } catch (e) {
          if (e instanceof RpcError) throw e; // timed out: don't try again
          // RequestDenied for the PTY: open a plain shell instead, like the original.
          pty = false;
          stream = await shellOn(false);
        }
      } else {
        stream = await shellOn(false);
      }
      if (this.closed) {
        stream.close();
        ensureOpen();
      }
      const shell: Shell = { id: randomUUID(), client: c, stream, pty, exited: false, unacked: 0, paused: false };
      this.shells.set(shell.id, shell);
      const command = pty ? `shell (PTY ${cols}×${rows})` : 'shell (no PTY)';
      this.emit(CMD_LOG_EVENT, { id: logId, phase: 'start', target, command, kind: 'stream', at: started } satisfies CmdLog);
      this.wire(shell, (exit) =>
        this.emit(CMD_LOG_EVENT, {
          id: logId,
          phase: 'end',
          target,
          command,
          kind: 'stream',
          at: Date.now(),
          durationMs: Date.now() - started,
          ...(exit.error ? { error: exit.error } : { exitCode: exit.code ?? null }),
        } satisfies CmdLog),
      );
      return { shellId: shell.id, pty, title: `${device.username}@${device.host}` };
    } catch (e) {
      client?.end();
      if (e instanceof RpcError) throw e;
      throw new RpcError(ShellErrorCodes.Failed, 'The TV didn’t start a shell.', (e as Error).message);
    } finally {
      this.pending--;
    }
  }

  private wire(shell: Shell, onEnd: (exit: Omit<ShellExit, 'shellId'>) => void) {
    const { id, stream, client } = shell;
    let buf: { stream: 'stdout' | 'stderr'; chunks: Buffer[]; size: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!buf) return;
      const out: ShellOutput = { shellId: id, data: Buffer.concat(buf.chunks).toString('base64') };
      if (buf.stream === 'stderr') out.stream = 'stderr';
      shell.unacked += buf.size;
      buf = null;
      this.emit(SHELL_OUTPUT_EVENT, out);
      if (shell.unacked > ACK_HIGH && !shell.paused) {
        shell.paused = true;
        stream.pause();
      }
    };
    const push = (which: 'stdout' | 'stderr') => (c: Buffer) => {
      if (buf && buf.stream !== which) flush();
      buf ??= { stream: which, chunks: [], size: 0 };
      buf.chunks.push(c);
      buf.size += c.length;
      if (buf.size >= FLUSH_BYTES) flush();
      else timer ??= setTimeout(flush, FLUSH_MS);
    };
    stream.on('data', push('stdout'));
    stream.stderr.on('data', push('stderr'));

    let code: number | null = null;
    let signal: string | undefined;
    stream.on('exit', (c: number | null, sig?: string) => {
      code = typeof c === 'number' ? c : null;
      if (sig) signal = sig;
    });
    const end = (error?: string) => {
      if (shell.exited) return;
      shell.exited = true;
      flush();
      this.shells.delete(id);
      const exit: Omit<ShellExit, 'shellId'> = error ? { error } : { code, ...(signal ? { signal } : {}) };
      this.emit(SHELL_EXIT_EVENT, { shellId: id, ...exit } satisfies ShellExit);
      onEnd(exit);
      client.end();
    };
    stream.on('close', () => end());
    client.on('close', () => end('The connection to the TV was closed.'));
  }

  private get(id: string): Shell {
    const s = this.shells.get(id);
    if (!s || s.exited) throw new RpcError(ShellErrorCodes.NotFound, 'That terminal has ended.');
    return s;
  }

  write(id: string, data: string) {
    this.get(id).stream.write(data);
  }

  resize(id: string, rows: number, cols: number) {
    const s = this.get(id);
    if (s.pty) s.stream.setWindow(rows, cols, 0, 0);
  }

  /** The client has drawn `bytes` of output: let more through. */
  ack(id: string, bytes: number) {
    const s = this.shells.get(id);
    if (!s) return;
    s.unacked = Math.max(0, s.unacked - bytes);
    if (s.paused && s.unacked < ACK_LOW) {
      s.paused = false;
      s.stream.resume();
    }
  }

  close(id: string) {
    const s = this.shells.get(id);
    if (!s) return;
    s.stream.close();
    s.client.end();
  }

  /** The WebSocket closed: end every shell, including ones still opening. */
  closeAll() {
    this.closed = true;
    for (const id of [...this.shells.keys()]) this.close(id);
  }
}
