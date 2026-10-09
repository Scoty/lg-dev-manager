/**
 * Parsers for the debug tools — ports of remote-log.service.ts (parsePmLog, parseDmesg),
 * DeviceManagerService's CrashReport.parseTitle and ls-monitor.component.ts. All output is plain data; the UI
 * renders it as text, never as HTML.
 */

export const LOG_LEVELS = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 0 = most severe. Unknown levels count as info. */
export function levelRank(level: string): number {
  const i = LOG_LEVELS.indexOf(normalizeLevel(level));
  return i < 0 ? LOG_LEVELS.indexOf('info') : i;
}

/** dmesg says `warn`/`emerg`, syslog `warning`/`err`; map the spellings onto PmLog's. */
export function normalizeLevel(level: string): LogLevel {
  const l = level.toLowerCase();
  if (l === 'warn') return 'warning';
  if (l === 'error') return 'err';
  if (l === 'panic') return 'emerg';
  return (LOG_LEVELS as readonly string[]).includes(l) ? (l as LogLevel) : 'info';
}

export interface LogEntry {
  /** Sequence number within the stream (stable React key). */
  seq: number;
  raw: string;
  /** ISO time from the line, or when it arrived. */
  time?: string;
  /** Seconds since boot. */
  monotonic?: number;
  level: LogLevel;
  facility?: string;
  process?: string;
  pid?: string;
  context?: string;
  msgid?: string;
  message: string;
  extras?: Record<string, unknown>;
}

/** Index of the bracket that closes the `{` at `start` (find-matching-bracket), honouring JSON strings. */
export function matchBracket(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const PMLOG = /^(?<datetime>[\w:.\-+]+) \[(?<monotonic>\d+\.\d+)\] (?<facility>\S+)\.(?<level>\S+) (?<process>\S+) \[(?:(?<pid>\d+)(?::(?<tid>\d+))?)?\] (?<context>\S+) (?<msgid>\S+) (?<remaining>\{.*)$/;

/** One /var/log/messages line in PmLog's format; anything else becomes an info line with the text as message. */
export function parseSyslog(line: string, seq: number, now: () => string = () => new Date().toISOString()): LogEntry | null {
  const raw = line.trimEnd();
  if (!raw.trim()) return null;
  const m = PMLOG.exec(raw);
  if (!m?.groups) {
    // Lines that only start with a timestamp (busybox syslogd): keep the time, the rest is the message.
    const t = /^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)?)\s+(.*)$/.exec(raw);
    return { seq, raw, time: t ? t[1] : now(), level: 'info', message: t ? t[2]! : raw };
  }
  const g = m.groups as Record<string, string | undefined>;
  const remaining = g.remaining!;
  const end = matchBracket(remaining, 0);
  let extras: Record<string, unknown> | undefined;
  let message = remaining;
  if (end > 0) {
    try {
      const parsed: unknown = JSON.parse(remaining.slice(0, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extras = parsed as Record<string, unknown>;
    } catch {
      /* keep it in the message */
    }
    message = remaining.slice(end + 1).trim();
  }
  return {
    seq,
    raw,
    time: g.datetime,
    monotonic: parseFloat(g.monotonic!),
    level: normalizeLevel(g.level!),
    facility: g.facility,
    process: g.process,
    ...(g.pid ? { pid: g.tid ? `${g.pid}:${g.tid}` : g.pid } : {}),
    context: g.context,
    msgid: g.msgid,
    message,
    ...(extras && Object.keys(extras).length ? { extras } : {}),
  };
}

const DMESG_X = /^(?<facility>\S+)\s*:(?<level>\S+)\s*:\s*\[\s*(?<monotonic>\d+\.\d+)\]\s+(?:(?<context>[^\s:][^:]{0,60}?): )?(?<message>.*)$/;
const DMESG_PLAIN = /^(?:<(?<prio>\d+)>)?\[\s*(?<monotonic>\d+\.\d+)\]\s+(?:(?<context>[^\s:][^:]{0,60}?): )?(?<message>.*)$/;
const PRIO_LEVELS: LogLevel[] = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

/** A `dmesg -x` line (`kern  :info  : [   12.3] usb 1-1: …`), or busybox's plain `[   12.3] …` / `<6>[ 12.3] …`. */
export function parseDmesg(line: string, seq: number): LogEntry | null {
  const raw = line.trimEnd();
  if (!raw.trim()) return null;
  const x = DMESG_X.exec(raw);
  if (x?.groups) {
    const g = x.groups as Record<string, string | undefined>;
    return {
      seq,
      raw,
      monotonic: parseFloat(g.monotonic!),
      level: normalizeLevel(g.level!),
      facility: g.facility,
      ...(g.context ? { context: g.context } : {}),
      message: g.message!,
    };
  }
  const p = DMESG_PLAIN.exec(raw);
  if (p?.groups) {
    const g = p.groups as Record<string, string | undefined>;
    return {
      seq,
      raw,
      monotonic: parseFloat(g.monotonic!),
      level: g.prio ? PRIO_LEVELS[Number(g.prio) & 7]! : 'info',
      ...(g.context ? { context: g.context } : {}),
      message: g.message!,
    };
  }
  return { seq, raw, level: 'info', message: raw };
}

/** "12:34:56.789" from an ISO time; seconds since boot for dmesg. */
export function shortTime(e: Pick<LogEntry, 'time' | 'monotonic'>): string {
  if (e.time) {
    const m = /T(\d\d:\d\d:\d\d(?:\.\d{1,3})?)/.exec(e.time);
    if (m) return m[1]!;
    return e.time;
  }
  if (e.monotonic !== undefined) return e.monotonic.toFixed(3);
  return '';
}

// ---------- crash reports ----------

export interface CrashTitle {
  title: string;
  summary: string;
  /** File name to save the report under (without extension). */
  saveName: string;
}

/**
 * CrashReport.parseTitle: faultmanager names encode the crashed executable's path with control characters for `/`,
 * then `____<process>.<pid>.<…>`. Apps get their id as the title.
 */
export function parseCrashName(filename: string): CrashTitle {
  // eslint-disable-next-line no-control-regex
  const name = filename.replace(/[\x00-\x1f]/g, '/').replace(/\.gz$/, '');
  let appDirIdx = -1;
  let appDirPrefix = '';
  for (const prefix of ['/usr/palm/applications/', '/var/palm/jail/']) {
    appDirIdx = name.indexOf(prefix);
    if (appDirIdx >= 0) {
      appDirPrefix = prefix;
      break;
    }
  }
  let processName = '';
  let processId = '';
  let summary = '';
  let saveName = name.replace(/\//g, '_');
  const match = /.*____(.+)\.(\d+)\..+$/.exec(name);
  if (match) {
    const startIdx = name.indexOf('/');
    const endIdx = name.lastIndexOf('____');
    processName = match[1]!;
    processId = match[2]!;
    summary = name.substring(startIdx, endIdx);
    saveName = summary.replace(/\//g, '_');
  }
  if (appDirIdx < 0) {
    if (processName && processId && summary) return { title: `${processName} (${processId})`, summary, saveName: clean(saveName) };
    return { title: 'Unknown crash', summary: name, saveName: clean(saveName) };
  }
  const substr = name.substring(appDirIdx + appDirPrefix.length);
  const firstSlash = substr.indexOf('/');
  const lastSlash = substr.lastIndexOf('/');
  const appId = substr.substring(0, firstSlash > 0 ? firstSlash : undefined);
  if (lastSlash > 0) {
    const lastUnderscoreIdx = substr.lastIndexOf('____');
    if (lastUnderscoreIdx > 0) summary = substr.substring(lastSlash + 1, lastUnderscoreIdx);
  }
  return { title: processId ? `${appId} (${processId})` : appId, summary, saveName: clean(saveName) };
}

const clean = (s: string) => s.replace(/^_+/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'crash';

// ---------- luna bus monitor (ls-monitor -j) ----------

export interface MonitorMessage {
  senderUniqueName?: string;
  destinationUniqueName?: string;
  type: string;
  replyToken?: number;
  token?: number;
  transport?: string;
  sender?: string;
  destination?: string;
  methodCategory?: string;
  method?: string;
  payload?: unknown;
  rawPayload?: string;
}

export function parseMonitorLine(line: string): MonitorMessage | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(t);
    if (!v || typeof v !== 'object' || typeof (v as MonitorMessage).type !== 'string') return null;
    return v as MonitorMessage;
  } catch {
    return null;
  }
}

export interface MonitorItem extends MonitorMessage {
  information: string;
}

export interface CallEntry {
  id: number;
  /** Replies not kept because the call had too many (a long-lived subscription). */
  skipped?: number;
  name: string;
  sender: string;
  destination: string;
  information: string;
  messages: MonitorItem[];
  /** Whether a reply came back, and if it said returnValue: false. */
  status: 'pending' | 'ok' | 'error' | 'cancelled';
}

export interface MonitorQuery {
  text: string[];
  sender: string[];
  destination: string[];
  exclude: { text: string[]; sender: string[]; destination: string[] };
}

/** `sender:a destination:b -sender:c words` (the original's tokenized search bar, keywords sender and destination). */
export function parseMonitorQuery(q: string): MonitorQuery {
  const out: MonitorQuery = { text: [], sender: [], destination: [], exclude: { text: [], sender: [], destination: [] } };
  for (const tok of q.match(/-?(?:\w+:)?(?:"[^"]*"|\S+)/g) ?? []) {
    const neg = tok.startsWith('-') && tok.length > 1;
    const body = neg ? tok.slice(1) : tok;
    const m = /^(sender|destination):(.*)$/.exec(body);
    const target = neg ? out.exclude : out;
    const val = (m ? m[2]! : body).replace(/^"|"$/g, '');
    if (!val) continue;
    if (m) target[m[1] as 'sender' | 'destination'].push(val);
    else target.text.push(val.toLowerCase());
  }
  return out;
}

export function monitorMatches(e: Pick<CallEntry, 'name' | 'sender' | 'destination' | 'information'>, q: MonitorQuery): boolean {
  const has = (list: string[], v: string) => list.some((x) => v === x || v.startsWith(`${x}`));
  if (has(q.exclude.sender, e.sender) || has(q.exclude.destination, e.destination)) return false;
  if (q.sender.length && !has(q.sender, e.sender)) return false;
  if (q.destination.length && !has(q.destination, e.destination)) return false;
  const hay = `${e.name} ${e.sender} ${e.information}`.toLowerCase();
  if (q.exclude.text.some((t) => hay.includes(t))) return false;
  return q.text.every((t) => hay.includes(t));
}

const information = (m: MonitorMessage) => m.rawPayload ?? (m.payload === undefined ? '' : JSON.stringify(m.payload));

/** ls-monitor.component.ts messageKey: pairs a call with its replies and cancels. */
function messageKey(m: MonitorMessage): string {
  switch (m.type) {
    case 'return':
      return `${m.destinationUniqueName}:${m.senderUniqueName}:${m.replyToken}`;
    case 'callCancel':
      return `${m.senderUniqueName}:${m.destinationUniqueName}:${(m.payload as { token?: unknown } | undefined)?.token}`;
    default:
      return `${m.senderUniqueName}:${m.destinationUniqueName}:${m.token}`;
  }
}

const callName = (m: MonitorMessage) => `${m.destination ?? ''}${(m.methodCategory ?? '').replace(/\/+$/, '')}/${m.method ?? ''}`;

/** Replies kept per call. */
export const MAX_REPLIES = 500;

/**
 * Groups `ls-monitor -j` output into calls, as the original does: only TX messages count; a `call` starts an entry,
 * `return` / `callCancel` attach to it. Keeps the newest `max` calls.
 */
export class MonitorCapture {
  calls: CallEntry[] = [];
  private byKey = new Map<string, CallEntry>();
  private keyOf = new WeakMap<CallEntry, string>();
  private nextId = 1;
  constructor(private readonly max = 20_000) {}

  add(m: MonitorMessage): boolean {
    if (m.transport !== undefined && m.transport !== 'TX') return false;
    if (m.type === 'call') {
      const item = { ...m, information: information(m) };
      const entry: CallEntry = {
        id: this.nextId++,
        name: callName(m),
        sender: m.sender ?? '',
        destination: m.destination ?? '',
        information: item.information,
        messages: [item],
        status: 'pending',
      };
      const key = messageKey(m);
      this.calls.push(entry);
      this.byKey.set(key, entry);
      this.keyOf.set(entry, key);
      if (this.calls.length > this.max) {
        for (const o of this.calls.splice(0, this.calls.length - this.max)) {
          const k = this.keyOf.get(o);
          if (k !== undefined && this.byKey.get(k) === o) this.byKey.delete(k);
        }
      }
      return true;
    }
    if (m.type === 'return' || m.type === 'callCancel') {
      const entry = this.byKey.get(messageKey(m));
      if (!entry) return false;
      entry.messages.push({ ...m, information: information(m) });
      // Keep the call and its newest replies: a subscription can answer forever.
      if (entry.messages.length > MAX_REPLIES + 1) {
        entry.messages.splice(1, 1);
        entry.skipped = (entry.skipped ?? 0) + 1;
      }
      if (m.type === 'callCancel') entry.status = 'cancelled';
      else if (entry.status === 'pending' || entry.status === 'ok') {
        const rv = (m.payload as { returnValue?: unknown } | undefined)?.returnValue;
        entry.status = rv === false ? 'error' : 'ok';
      }
      return true;
    }
    return false;
  }
}
