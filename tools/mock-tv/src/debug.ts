import { gzipSync } from 'node:zlib';
import type { MockState } from './state.js';
import { unquote } from './shell.js';

/**
 * Debug tools on the fake TV (M7): /var/log/messages in PmLog's format, the kernel ring buffer, `ls-monitor -j`
 * luna bus traffic, `PmLogCtl` and native crash reports. Output shapes follow real webOS TVs (busybox, pmlogd).
 */

export interface DebugState {
  /** Kernel ring buffer (`dmesg`). */
  dmesg: { facility: string; level: string; t: number; msg: string }[];
  /** PmLog contexts → level (`PmLogCtl show`). */
  pmlog: Map<string, string>;
  /** `system.collectDevLogs` was set (config/setConfigs) or pmlogd/setdevlogstatus called. */
  devLogs: boolean;
  /** How often a followed log gets a new line, ms. */
  every: number;
  /** Sequence number for generated lines (makes them distinct). */
  seq: number;
}

export const SYSLOG = '/var/log/messages';
export const CRASH_DIR = '/tmp/faultmanager/crash';

const PMLOG_CONTEXTS: [string, string][] = [
  ['<default>', 'info'],
  ['sam', 'info'],
  ['surface-manager', 'notice'],
  ['com.webos.service.applicationmanager', 'info'],
  ['LunaSysService', 'warning'],
  ['ls-hubd', 'err'],
];

const uptime = () => process.uptime() + 3600;

/** One /var/log/messages line, PmLog style: `<iso time> [<monotonic>] <facility>.<level> <process> [<pid>:<tid>] <context> <msgid> {json} <text>` */
function pmlogLine(level: string, process: string, context: string, msgid: string, extras: Record<string, unknown>, text: string, pid = ''): string {
  return `${new Date().toISOString().replace('Z', '000Z')} [${uptime().toFixed(6)}] user.${level} ${process} [${pid}] ${context} ${msgid} ${JSON.stringify(extras)} ${text}`;
}

const SAMPLES: (() => string)[] = [
  () => pmlogLine('info', 'sam', 'sam', 'APP_LAUNCH', { APP_ID: 'com.webos.app.home', CALLER: 'com.webos.surfacemanager' }, 'launching app'),
  () => pmlogLine('debug', 'surface-manager', 'surface-manager', 'SM_FOCUS', { window: 42 }, 'focus changed', '812:830'),
  () => pmlogLine('warning', 'LunaSysService', 'LunaSysService', 'TIME_SYNC', { source: 'ntp' }, 'clock adjusted by 0.42s'),
  () => pmlogLine('err', 'ls-hubd', 'ls-hubd', 'LSHUB_NO_SERVICE', { SERVICE_NAME: 'com.example.gone' }, 'Service not found'),
  () => pmlogLine('notice', 'sam', 'sam', 'APP_CLOSE', { APP_ID: 'com.example.hello' }, 'app closed'),
  // Not every line is in PmLog's format (e.g. from busybox syslogd itself).
  () => `${new Date().toISOString()} kernel: mock-tv syslogd started`,
];

const KERNEL: [string, string, string][] = [
  ['kern', 'info', 'usb 1-1: new high-speed USB device number 3 using ehci-platform'],
  ['kern', 'notice', 'EXT4-fs (sda1): mounted filesystem with ordered data mode'],
  ['kern', 'warn', 'mtk_vdec: buffer underrun on stream 0'],
  ['kern', 'err', 'wlan0: deauthenticating from 02:00:00:00:00:01 by local choice (Reason: 3)'],
  ['daemon', 'info', 'systemd[1]: Started Mock TV services.'],
];

export function createDebugState(root: boolean): DebugState {
  const d: DebugState = { dmesg: [], pmlog: new Map(PMLOG_CONTEXTS), devLogs: false, every: 400, seq: 0 };
  for (let i = 0; i < KERNEL.length; i++) {
    const [facility, level, msg] = KERNEL[i]!;
    d.dmesg.push({ facility, level, t: 1.5 + i * 0.75, msg });
  }
  void root;
  return d;
}

/** Seed /var/log/messages and some crash reports. */
export function seedDebugFiles(state: MockState) {
  const lines = Array.from({ length: 30 }, (_, i) => SAMPLES[i % SAMPLES.length]!());
  state.files.set(SYSLOG, Buffer.from(`${lines.join('\n')}\n`));
  state.dirs.add('/var/log');
  state.dirs.add('/tmp/faultmanager');
  state.dirs.add(CRASH_DIR);
  // faultmanager names: the executable's path with a control character for each `/`, then ____<name>.<pid>.<kind>.
  const report = (exe: string, pid: number) =>
    `Crash report for ${exe} (pid ${pid})\nSignal: 11 (SIGSEGV)\n\nBacktrace:\n#0  0x0000abcd in crash_here () at main.c:42\n#1  0x0000ef01 in main () at main.c:7\n`;
  state.files.set(
    `${CRASH_DIR}/\x01usr\x01palm\x01applications\x01com.example.crashy\x01crashy____crashy.4242.core.gz`,
    gzipSync(report('/usr/palm/applications/com.example.crashy/crashy', 4242)),
  );
  state.files.set(`${CRASH_DIR}/\x01usr\x01sbin\x01surface-manager____surface-manager.1001.core.gz`, gzipSync(report('/usr/sbin/surface-manager', 1001)));
  state.files.set(`${CRASH_DIR}/oops.txt`, Buffer.from('Kernel oops (plain text report)\n'));
}

const fmtDmesg = (e: DebugState['dmesg'][number]) => `${e.facility.padEnd(6)}:${e.level.padEnd(6)}: [${e.t.toFixed(6).padStart(12)}] ${e.msg}`;

const denied = (msg: string) => ({ stdout: '', stderr: `${msg}\n`, code: 1 });

/** Quick (non-following) debug commands. Null if the command isn't one of them. */
export function runDebugCommand(command: string, state: MockState): { stdout: string; stderr?: string; code: number } | null {
  const root = state.username === 'root';
  if (command === `: > ${SYSLOG}` || command === `: > '${SYSLOG}'`) {
    if (!root) return denied(`sh: can't create ${SYSLOG}: Permission denied`);
    state.files.set(SYSLOG, Buffer.alloc(0));
    return { stdout: '', code: 0 };
  }
  if (command === 'dmesg -c > /dev/null') {
    if (!root) return denied('dmesg: klogctl: Operation not permitted');
    state.debug.dmesg = [];
    return { stdout: '', code: 0 };
  }
  if (command === 'PmLogCtl show') {
    if (!root) return denied('PmLogCtl: Permission denied');
    // PmLogCtl prints to stderr on some firmware; the bridge reads both.
    const out = [...state.debug.pmlog].map(([c, l]) => `PmLogCtl: Context '${c}' = ${l}`).join('\n');
    return { stdout: `${out}\n`, code: 0 };
  }
  const set = /^PmLogCtl set ('(?:[^']|'\\'')*') (\w+)$/.exec(command);
  if (set) {
    if (!root) return denied('PmLogCtl: Permission denied');
    const ctx = unquote(set[1]!);
    const level = set[2]!;
    if (!['none', 'debug', 'info', 'notice', 'warning', 'err', 'crit', 'alert', 'emerg'].includes(level)) {
      return denied(`PmLogCtl: Invalid level '${level}'`);
    }
    const names = ctx === '*' ? [...state.debug.pmlog.keys()] : [ctx];
    for (const n of names) state.debug.pmlog.set(n, level);
    return { stdout: names.map((n) => `PmLogCtl: Setting context level for '${n}'.`).join('\n') + '\n', code: 0 };
  }
  return null;
}

const TAIL = /^tail -f -n (\d+) \/var\/log\/messages$/;
const DMESG_FOLLOW = 'dmesg -w -x || dmesg';
const LS_MONITOR = 'ls-monitor -j';

/** Commands that keep running and print as they go (followed logs). */
export function isDebugStream(command: string): boolean {
  return TAIL.test(command) || command === DMESG_FOLLOW || command === LS_MONITOR;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

/** Run a followed log until the client closes the channel. */
export async function runDebugStream(
  command: string,
  state: MockState,
  out: (s: string) => void,
  err: (s: string) => void,
  signal: AbortSignal,
): Promise<number> {
  const root = state.username === 'root';
  const d = state.debug;
  const tail = TAIL.exec(command);
  if (tail) {
    if (!root) {
      err(`tail: can't open '${SYSLOG}': Permission denied\n`);
      return 1;
    }
    const n = Number(tail[1]);
    const existing = (state.files.get(SYSLOG)?.toString('utf8') ?? '').split('\n').filter(Boolean);
    if (n > 0 && existing.length) out(`${existing.slice(-n).join('\n')}\n`);
    while (!signal.aborted) {
      await wait(d.every, signal);
      if (signal.aborted) break;
      const line = SAMPLES[d.seq++ % (SAMPLES.length - 1)]!();
      state.files.set(SYSLOG, Buffer.concat([state.files.get(SYSLOG) ?? Buffer.alloc(0), Buffer.from(`${line}\n`)]));
      out(`${line}\n`);
    }
    return 0;
  }
  if (command === DMESG_FOLLOW) {
    if (!root) {
      err('dmesg: klogctl: Operation not permitted\ndmesg: klogctl: Operation not permitted\n');
      return 1;
    }
    if (d.dmesg.length) out(`${d.dmesg.map(fmtDmesg).join('\n')}\n`);
    while (!signal.aborted) {
      await wait(d.every, signal);
      if (signal.aborted) break;
      const [facility, level, msg] = KERNEL[d.seq++ % KERNEL.length]!;
      const e = { facility, level, t: uptime(), msg };
      d.dmesg.push(e);
      out(`${fmtDmesg(e)}\n`);
    }
    return 0;
  }
  // ls-monitor -j: every call shows up as TX from the caller and RX at the service, then the reply the same way.
  if (!root) {
    err('ls-monitor: Unable to register on the hub: Permission denied\n');
    return 1;
  }
  const CALLS = [
    { sender: 'com.webos.surfacemanager', destination: 'com.webos.service.applicationmanager', category: '/', method: 'getForegroundAppInfo', payload: { subscribe: false }, reply: { returnValue: true, appId: 'com.webos.app.home' } },
    { sender: 'com.webos.app.home', destination: 'com.webos.service.config', category: '/', method: 'getConfigs', payload: { configNames: ['system.collectDevLogs'] }, reply: { returnValue: true, configs: { 'system.collectDevLogs': d.devLogs } } },
    { sender: 'com.webos.service.tv.systemproperty', destination: 'com.webos.service.settings', category: '/', method: 'getSystemSettings', payload: { category: 'picture', keys: ['brightness'] }, reply: { returnValue: true, settings: { brightness: '50' } } },
    { sender: 'com.example.hello', destination: 'com.webos.notification', category: '/', method: 'createToast', payload: { message: 'Hello <b>from</b> the mock TV' }, reply: { returnValue: false, errorCode: -1, errorText: 'Not allowed' } },
  ];
  let token = 100;
  while (!signal.aborted) {
    const c = CALLS[d.seq++ % CALLS.length]!;
    const t = token++;
    const su = `:1.${t % 7}`;
    const du = `:1.${(t % 5) + 10}`;
    const msg = (o: Record<string, unknown>) => out(`${JSON.stringify(o)}\n`);
    const call = { senderUniqueName: su, destinationUniqueName: du, type: 'call', token: t, sender: c.sender, destination: c.destination, methodCategory: c.category, method: c.method, payload: c.payload };
    msg({ ...call, transport: 'TX' });
    msg({ ...call, transport: 'RX' });
    await wait(d.every / 4, signal);
    if (signal.aborted) break;
    const ret = { senderUniqueName: du, destinationUniqueName: su, type: 'return', replyToken: t, sender: c.destination, destination: c.sender, methodCategory: '', method: '', payload: c.reply };
    msg({ ...ret, transport: 'TX' });
    msg({ ...ret, transport: 'RX' });
    await wait(d.every, signal);
  }
  return 0;
}
