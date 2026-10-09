import { randomUUID } from 'node:crypto';
import type { CmdLog, DeviceTarget } from '@lgdm/protocol';
import type { Channel, ExecOptions, ExecResult, RawExecResult, SshPool, SshRunner, TraceKind } from './pool.js';

const MAX_LOG_OUTPUT = 8 * 1024;

const targetOf = (t: DeviceTarget) => `${t.username}@${t.host}:${t.port}`;

/** Text for the console: UTF-8 output, or a summary for binary data, capped at 8 KB. */
export function summarize(stdout: Buffer, stderr: Buffer): string | undefined {
  const parts: string[] = [];
  for (const b of [stdout, stderr]) {
    if (!b.length) continue;
    const sample = b.subarray(0, 512);
    let odd = 0;
    for (const c of sample) if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) odd++;
    if (odd > sample.length / 20) {
      parts.push(`<${b.length} bytes of binary data>`);
      continue;
    }
    const text = b.toString('utf8');
    parts.push(text.length > MAX_LOG_OUTPUT ? `${text.slice(0, MAX_LOG_OUTPUT)}\n… (${text.length - MAX_LOG_OUTPUT} more characters)` : text);
  }
  const out = parts.join('').replace(/\s+$/, '');
  return out || undefined;
}

/**
 * The pool, seen through one client's eyes: every command, transfer and tunnel is reported to that client as
 * `cmd.log` events. Commands are built by the bridge and never contain credentials; stdin (e.g. an IPK piped to
 * `cat >`) is never logged.
 */
export class LoggedSsh implements SshRunner {
  constructor(
    private readonly pool: SshPool,
    private readonly emit: (e: CmdLog) => void,
    private readonly quiet = false,
  ) {}

  private begin(t: DeviceTarget, command: string, kind: CmdLog['kind']) {
    const id = randomUUID();
    const started = Date.now();
    const base = { id, target: targetOf(t), command, kind, ...(this.quiet ? { quiet: true } : {}) };
    this.emit({ ...base, phase: 'start', at: started });
    return (end: Pick<CmdLog, 'exitCode' | 'output' | 'error'>) =>
      this.emit({ ...base, phase: 'end', at: Date.now(), durationMs: Date.now() - started, ...end });
  }

  acquire(t: DeviceTarget) {
    return this.pool.acquire(t);
  }

  sftp(t: DeviceTarget) {
    return this.pool.sftp(t);
  }

  async execRaw(t: DeviceTarget, command: string, opts: ExecOptions = {}): Promise<RawExecResult> {
    const end = this.begin(t, command, 'exec');
    try {
      const r = await this.pool.execRaw(t, command, opts);
      end({ exitCode: r.exitCode, output: summarize(r.stdout, r.stderr) });
      return r;
    } catch (e) {
      end({ error: (e as Error).message });
      throw e;
    }
  }

  async exec(t: DeviceTarget, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const r = await this.execRaw(t, command, opts);
    return { stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), exitCode: r.exitCode };
  }

  async open(t: DeviceTarget, command: string): Promise<Channel> {
    const end = this.begin(t, command, 'stream');
    let ch: Channel;
    try {
      ch = await this.pool.open(t, command);
    } catch (e) {
      end({ error: (e as Error).message });
      throw e;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const tee = (arr: Buffer[]) => (c: Buffer) => {
      if (size < MAX_LOG_OUTPUT) arr.push(c);
      size += c.length;
    };
    ch.stream.on('data', tee(out));
    ch.stream.stderr.on('data', tee(err));
    let ended = false;
    const finish = (code: number | null) => {
      if (ended) return;
      ended = true;
      end({ exitCode: code, output: summarize(Buffer.concat(out), Buffer.concat(err)) });
    };
    ch.stream.on('close', (code: number | null) => finish(typeof code === 'number' ? code : null));
    return {
      stream: ch.stream,
      close: () => {
        ch.close();
        finish(null);
      },
    };
  }

  async traceOp<T>(t: DeviceTarget, kind: TraceKind, label: string, fn: () => Promise<T>): Promise<T> {
    const end = this.begin(t, label, kind);
    try {
      const r = await fn();
      end({ exitCode: 0 });
      return r;
    } catch (e) {
      end({ error: (e as Error).message });
      throw e;
    }
  }
}
