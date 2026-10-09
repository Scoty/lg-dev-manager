import { posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';
import {
  CRASH_DIRS,
  DeviceErrorCodes,
  ErrorCodes,
  FilesErrorCodes,
  MAX_CRASH_TEXT,
  type CrashReportFile,
  type DeviceTarget,
  type LogSource,
  type PmLogLevel,
} from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { lunaCall, shellQuote } from '../ssh/luna.js';
import type { SshRunner } from '../ssh/pool.js';
import { readFile, rmFile } from '../ssh/transfer.js';
import { listDir } from '../files/files.js';

/**
 * Debug tools (M7): ports of remote-log.service.ts and DeviceManagerService.listCrashReports. Every command here is
 * fixed by the bridge; the client only picks which one (LogSource) and, for PmLog, a validated context name.
 */

export const requireRoot = (device: DeviceTarget, what: string) => {
  if (device.username !== 'root') {
    throw new RpcError(DeviceErrorCodes.WrongLogin, `${what} needs a rooted TV (logged in as root).`);
  }
};

/**
 * Runs a followed command so it stops when the bridge closes the channel. Closing an SSH exec channel without a PTY
 * doesn't signal the process on the TV: it lives on until its next write fails — and `ls-monitor` never fails, so it
 * kept the bus name com.webos.monitor and every later capture got LUNASERVICE ERROR -1028. Here the command runs in
 * the background while `cat` waits on the channel's input (fd 3, saved first: background jobs get /dev/null); when
 * the channel closes, `cat` sees EOF and the command (and anything it started) is killed.
 */
export function untilChannelCloses(command: string): string {
  return [
    'exec 3<&0',
    `{ ${command}; } </dev/null & p=$!`,
    '( cat <&3; pkill -P $p; kill $p ) >/dev/null 2>&1 & w=$!',
    'wait $p; s=$?',
    'kill $w 2>/dev/null',
    'exit $s',
  ].join('; ');
}

/**
 * Only one ls-monitor can hold the bus name. One left over (a capture from an older bridge, or another tab) is
 * stopped first, so a new capture takes over instead of failing with -1028.
 */
const STOP_STALE_MONITOR = 'if killall ls-monitor 2>/dev/null || pkill -x ls-monitor 2>/dev/null; then sleep 1; fi';

/** The command that follows each log (remote-log.service.ts: logread, dmesg; ls-monitor.component.ts). */
export function logCommand(source: LogSource, lines: number): string {
  switch (source) {
    case 'syslog':
      return untilChannelCloses(`tail -f -n ${Math.max(0, Math.min(5000, Math.floor(lines)))} /var/log/messages`);
    case 'dmesg':
      // `-w` (follow) needs util-linux dmesg; busybox's only prints the buffer once.
      return untilChannelCloses('dmesg -w -x || dmesg');
    case 'lsmonitor':
      return `${STOP_STALE_MONITOR}; ${untilChannelCloses('ls-monitor -j')}`;
  }
}

/**
 * Turn developer logging on before reading /var/log/messages (PmLogComponent.logRead): webOS 4+ has
 * `config/setConfigs`, 3.x `pmlogd/setdevlogstatus`. The original picks by webOS version; trying the newer service
 * first and falling back gives the same calls without reading the version. Failures are ignored, as there.
 */
export async function enableDevLogs(pool: SshRunner, device: DeviceTarget): Promise<void> {
  try {
    await lunaCall(pool, device, 'luna://com.webos.service.config/setConfigs', { configs: { 'system.collectDevLogs': true } }, false);
  } catch {
    await lunaCall(pool, device, 'luna://com.webos.pmlogd/setdevlogstatus', { recordDevLogs: true }, false).catch(() => {});
  }
}

const FLUSH_MS = 150;
const MAX_PER_BATCH = 2000;
const MAX_PENDING = 10_000;
/** Longest line passed on; the rest of a longer line is skipped (one `…` marks the cut). */
const MAX_LINE = 16 * 1024;

/**
 * Splits a byte stream into lines and hands them on in batches every 150 ms, so a chatty log (ls-monitor can print
 * thousands of lines a second) arrives as a few messages rather than one per line. If the client can't keep up,
 * lines beyond a backlog of 10 000 are dropped and counted.
 */
export class LineBatcher {
  private readonly decoder = new StringDecoder('utf8');
  private partial = '';
  private pending: string[] = [];
  private dropped = 0;
  private timer: NodeJS.Timeout | null = null;
  /** Inside an over-long line that was already cut: skip until its newline. */
  private skipping = false;
  sawOutput = false;

  constructor(
    private readonly send: (lines: string[], dropped: number) => void,
    private readonly maxLine = MAX_LINE,
  ) {}

  push(chunk: Buffer) {
    this.sawOutput = true;
    let text = this.decoder.write(chunk);
    if (this.skipping) {
      const nl = text.indexOf('\n');
      if (nl < 0) return;
      this.skipping = false;
      text = text.slice(nl + 1);
    }
    const parts = (this.partial + text).split('\n');
    this.partial = parts.pop() ?? '';
    for (const p of parts) this.add(p);
    if (this.partial.length > this.maxLine) {
      // A line longer than the limit: pass its start on once and drop the rest of it.
      this.add(this.partial);
      this.partial = '';
      this.skipping = true;
    }
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private add(line: string) {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (this.pending.length >= MAX_PENDING) {
      this.dropped++;
      return;
    }
    this.pending.push(l.length > this.maxLine ? `${l.slice(0, this.maxLine)} …` : l);
  }

  /** Send what is waiting; `end` also sends a last line without a newline. */
  flush(end = false) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (end) {
      const rest = this.skipping ? '' : this.partial + this.decoder.end();
      this.partial = '';
      this.skipping = false;
      if (rest) this.add(rest);
    }
    while (this.pending.length || this.dropped) {
      const batch = this.pending.splice(0, MAX_PER_BATCH);
      this.send(batch, this.dropped);
      this.dropped = 0;
      if (!end) break;
    }
    if (this.pending.length) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Empty the system log or the kernel ring buffer (logClear, dmesgClear). */
export async function clearLog(pool: SshRunner, device: DeviceTarget, source: 'syslog' | 'dmesg'): Promise<void> {
  requireRoot(device, 'Clearing logs');
  // The original writes an empty line (`echo > /var/log/messages`); `: >` empties it.
  const cmd = source === 'syslog' ? ': > /var/log/messages' : 'dmesg -c > /dev/null';
  const res = await pool.exec(device, cmd, { timeoutMs: 20_000 });
  if (res.exitCode !== 0) {
    throw new RpcError(DeviceErrorCodes.CommandFailed, source === 'syslog' ? 'Couldn’t clear the system log.' : 'Couldn’t clear the kernel log.', res.stderr.trim());
  }
}

/** PmLog contexts and levels (pmLogShow). Some firmware prints them on stderr. */
export async function pmLogShow(pool: SshRunner, device: DeviceTarget): Promise<{ name: string; level: string }[]> {
  requireRoot(device, 'PmLog');
  const res = await pool.exec(device, 'PmLogCtl show', { timeoutMs: 20_000, maxOutput: 1024 * 1024 });
  const text = res.stdout || res.stderr;
  const contexts = [...text.matchAll(/^PmLogCtl: Context '([^']+)' = (.+)$/gm)].map((m) => ({ name: m[1]!, level: m[2]!.trim() }));
  if (!contexts.length && res.exitCode !== 0) {
    throw new RpcError(DeviceErrorCodes.CommandFailed, 'Couldn’t read the log levels (PmLogCtl show).', res.stderr.trim() || res.stdout.trim());
  }
  return contexts;
}

/** Set a context's level (pmLogSetLevel). Returns the contexts PmLogCtl reports as changed. */
export async function pmLogSet(pool: SshRunner, device: DeviceTarget, context: string, level: PmLogLevel): Promise<string[]> {
  requireRoot(device, 'PmLog');
  const res = await pool.exec(device, `PmLogCtl set ${shellQuote(context)} ${level}`, { timeoutMs: 20_000, maxOutput: 1024 * 1024 });
  const changed = [...`${res.stdout}\n${res.stderr}`.matchAll(/^PmLogCtl: Setting context level for '([^']+)'/gm)].map((m) => m[1]!);
  if (res.exitCode !== 0 && !changed.length) {
    throw new RpcError(DeviceErrorCodes.CommandFailed, `Couldn’t set the level of ${context}.`, res.stderr.trim() || res.stdout.trim());
  }
  return changed;
}

/** Crash reports in the first crash folder that exists (listCrashReports), newest first. */
export async function listCrashReports(pool: SshRunner, device: DeviceTarget): Promise<{ dir: string | null; reports: CrashReportFile[] }> {
  for (const dir of CRASH_DIRS) {
    const listing = await listDir(pool, device, dir).catch((e: RpcError) => {
      if (e instanceof RpcError && e.code === FilesErrorCodes.NotFound) return null;
      throw e;
    });
    if (!listing) continue;
    const reports = listing.items
      .filter((f) => f.type === '-' || (f.type === 'l' && f.link?.type === '-'))
      .map((f) => ({
        name: f.name,
        path: posix.join(listing.path, f.name),
        size: f.size,
        mtime: f.mtime * 1000,
        writable: f.access?.write ?? false,
      }))
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return { dir: listing.path, reports };
  }
  return { dir: null, reports: [] };
}

/** Only files directly inside a crash folder — these RPCs are not a general file reader. */
function crashPath(path: string): string {
  const p = posix.normalize(path);
  const dir = `${posix.dirname(p)}/`;
  if (!CRASH_DIRS.includes(dir as (typeof CRASH_DIRS)[number]) || posix.basename(p) === '') {
    throw new RpcError(ErrorCodes.BadRequest, 'Not a crash report.');
  }
  return p;
}

const MAX_CRASH_FILE = 16 * 1024 * 1024;

/** Unzip at most `max` bytes. */
function gunzipCapped(buf: Buffer, max: number): Promise<{ data: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const g = createGunzip();
    const parts: Buffer[] = [];
    let n = 0;
    let done = false;
    g.on('data', (c: Buffer) => {
      if (done) return;
      if (n + c.length > max) {
        parts.push(c.subarray(0, max - n));
        done = true;
        g.destroy();
        resolve({ data: Buffer.concat(parts), truncated: true });
        return;
      }
      parts.push(c);
      n += c.length;
    });
    g.on('end', () => !done && resolve({ data: Buffer.concat(parts), truncated: false }));
    g.on('error', (e) => !done && reject(e));
    g.end(buf);
  });
}

/** A crash report's text (CrashReport.obtain reads it with gzip decoding). */
export async function readCrashReport(pool: SshRunner, device: DeviceTarget, path: string): Promise<{ text: string; truncated: boolean }> {
  const p = crashPath(path);
  const raw = await readFile(pool, device, p, MAX_CRASH_FILE);
  let data: Buffer = raw;
  let truncated = false;
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      ({ data, truncated } = await gunzipCapped(raw, MAX_CRASH_TEXT));
    } catch (e) {
      throw new RpcError(DeviceErrorCodes.CommandFailed, 'The crash report is damaged (it could not be unzipped).', (e as Error).message);
    }
  } else if (raw.length > MAX_CRASH_TEXT) {
    data = raw.subarray(0, MAX_CRASH_TEXT);
    truncated = true;
  }
  return { text: data.toString('utf8').trim(), truncated };
}

export async function deleteCrashReport(pool: SshRunner, device: DeviceTarget, path: string): Promise<void> {
  await rmFile(pool, device, crashPath(path));
}
