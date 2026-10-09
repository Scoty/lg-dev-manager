import { useMedia } from '../../lib/useMedia';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogSource } from '@lgdm/protocol';
import { Alert } from '../../components/Alert';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useRpc } from '../../bridge/useRpc';
import { toTarget, type SavedDevice } from '../../devices/store';
import { saveBlob } from '../files/transfer';
import { LOG_LEVELS, levelRank, shortTime, type LogEntry, type LogLevel } from './parse';
import { useLogStream } from './useLogStream';
import { VirtualList } from './VirtualList';

/** Lines kept in the browser per log (LogReaderComponent.retainLogs). */
export const RETAIN = 10_000;
const ROW = 24;

const LEVEL_LABEL: Record<LogLevel, string> = {
  emerg: 'EMERG',
  alert: 'ALERT',
  crit: 'CRIT',
  err: 'ERROR',
  warning: 'WARN',
  notice: 'NOTICE',
  info: 'INFO',
  debug: 'DEBUG',
};

export interface LogColumn {
  key: string;
  label: string;
  /** CSS grid track. */
  width: string;
  get: (e: LogEntry) => string | undefined;
  /** Hidden on narrow screens. */
  wide?: boolean;
  /** Shown only once some line has a value for it (e.g. dmesg's source, which most TVs never print). */
  optional?: boolean;
}

/**
 * The log reader (LogReaderComponent + PmLogComponent / DmesgComponent): follows a log, with a level filter,
 * search, pause, download and clear. Rows are plain text; nothing from the TV is rendered as HTML.
 */
export function LogView({
  device,
  source,
  parse,
  columns,
  history,
  clearLabel,
  label,
}: {
  device: SavedDevice;
  source: Extract<LogSource, 'syslog' | 'dmesg'>;
  parse: (line: string, seq: number) => LogEntry | null;
  columns: LogColumn[];
  /** Lines of history to start with (syslog). */
  history?: number;
  clearLabel: string;
  label: string;
}) {
  const { call } = useRpc();
  const { confirm, toast } = useFeedback();
  const buffer = useRef<LogEntry[]>([]);
  const seq = useRef(0);
  const [entries, setEntries] = useState<readonly LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState('');
  const [minLevel, setMinLevel] = useState<LogLevel>('debug');
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const frame = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const publish = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (!pausedRef.current) setEntries(buffer.current.slice());
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onLines = useCallback(
    (lines: string[]) => {
      for (const l of lines) {
        const e = parse(l, ++seq.current);
        if (e) buffer.current.push(e);
      }
      if (buffer.current.length > RETAIN) buffer.current.splice(0, buffer.current.length - RETAIN);
      publish();
    },
    [parse, publish],
  );

  const { state, start, ready } = useLogStream(device, source, onLines, history !== undefined ? { lines: history } : {});

  const restart = useCallback(() => {
    buffer.current = [];
    setEntries([]);
    setSelected(null);
    start();
  }, [start]);

  // Start following as soon as the bridge is ready (as the original does when the tab opens).
  useEffect(() => {
    if (ready) restart();
  }, [ready, restart]);

  useEffect(() => {
    if (!paused) setEntries(buffer.current.slice());
  }, [paused]);

  const shown = useMemo(() => {
    const max = levelRank(minLevel);
    const q = query.trim().toLowerCase();
    return entries.filter((e) => levelRank(e.level) <= max && (!q || e.raw.toLowerCase().includes(q)));
  }, [entries, minLevel, query]);

  const clearOnTv = async () => {
    const ok = await confirm({
      title: source === 'syslog' ? 'Clear the system log on the TV?' : 'Clear the kernel log on the TV?',
      message: <p>{source === 'syslog' ? 'This empties /var/log/messages on the TV.' : 'This empties the kernel ring buffer (dmesg -c).'} It can’t be undone.</p>,
      confirmText: 'Clear',
      danger: true,
    });
    if (!ok) return;
    try {
      await call('logs.clear', { device: toTarget(device), source });
      toast({ kind: 'success', title: source === 'syslog' ? 'System log cleared' : 'Kernel log cleared' });
      restart();
    } catch (e) {
      toast({ kind: 'danger', title: 'Couldn’t clear the log', text: describeError(e).message });
    }
  };

  const download = () => {
    const text = buffer.current.map((e) => e.raw).join('\n');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    saveBlob(new Blob([`${text}\n`], { type: 'text/plain' }), `${device.name.replace(/[^A-Za-z0-9._-]+/g, '-')}-${source}-${stamp}.log`);
  };

  // Narrow screens drop the `wide` columns entirely (hidden grid items would still take their tracks).
  const narrow = useNarrow();
  const present = useMemo(
    () => new Set(columns.filter((c) => c.optional && entries.some((e) => c.get(e))).map((c) => c.key)),
    [columns, entries],
  );
  const cols = columns.filter((c) => !(narrow && c.wide) && (!c.optional || present.has(c.key)));
  const grid = { gridTemplateColumns: cols.map((c) => c.width).join(' ') };
  const running = state.phase === 'running';

  return (
    <section className="card col-12 log-card">
      <div className="data-toolbar log-toolbar">
        <div className="data-toolbar-left">
          <div className="input-icon">
            <span className="ico"><Icon name="search" /></span>
            <input className="input" type="search" placeholder="Filter lines…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter lines" />
          </div>
          <label className="log-level-pick">
            <span className="muted">Level</span>
            <select className="select" value={minLevel} onChange={(e) => setMinLevel(e.target.value as LogLevel)} aria-label="Lowest level to show">
              {[...LOG_LEVELS].reverse().map((l) => (
                <option key={l} value={l}>
                  {l === 'debug' ? 'All' : `${LEVEL_LABEL[l][0]}${LEVEL_LABEL[l].slice(1).toLowerCase()} and worse`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="data-toolbar-right">
          <span className={`log-status ${state.phase}`} role="status">
            <span className="dot" />
            {running ? (paused ? 'Paused' : 'Live') : state.phase === 'error' ? 'Stopped' : state.phase === 'idle' ? 'Starting…' : 'Ended'}
          </span>
          {running ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
              <Icon name={paused ? 'play' : 'clock'} /> {paused ? 'Resume' : 'Pause'}
            </button>
          ) : (
            <button type="button" className="btn btn--sm btn--ghost" onClick={restart} disabled={!ready}>
              <Icon name="refresh" /> Restart
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={download} disabled={!entries.length}>
            <Icon name="download" /> Save
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => {
              buffer.current = [];
              setEntries([]);
              setSelected(null);
            }}
            title="Empty this view (the TV’s log is kept)"
          >
            <Icon name="x" /> Clear view
          </button>
          <button type="button" className="btn btn--sm btn--ghost btn--danger-ghost" onClick={clearOnTv} disabled={!ready}>
            <Icon name="trash" /> {clearLabel}…
          </button>
        </div>
      </div>

      {state.phase === 'error' && <ErrorAlert error={state.error} title="Couldn’t follow the log" action={<button type="button" className="btn btn--sm btn--ghost" onClick={restart}>Try again</button>} />}
      {state.dropped > 0 && (
        <Alert kind="warning" title="Some lines were skipped">
          The log was busier than the bridge forwards ({state.dropped.toLocaleString()} lines skipped). Save it on the TV instead if you need every line.
        </Alert>
      )}

      <VirtualList
        items={shown}
        rowHeight={ROW}
        keyOf={(e) => e.seq}
        label={label}
        className="log-list"
        header={
          <div className="log-row log-head" style={grid}>
            {cols.map((c) => (
              <span key={c.key}>{c.label}</span>
            ))}
          </div>
        }
        empty={
          <div className="log-empty muted">
            {state.phase === 'running' || state.phase === 'idle' ? (entries.length ? 'No lines match the filter.' : 'Waiting for log lines…') : entries.length ? 'No lines match the filter.' : 'Nothing to show.'}
          </div>
        }
        render={(e) => (
          <button type="button" className={`log-row lvl-${e.level}${selected?.seq === e.seq ? ' is-selected' : ''}`} style={grid} onClick={() => setSelected(selected?.seq === e.seq ? null : e)}>
            {cols.map((c) => (
              <span key={c.key} className={`log-c-${c.key}`}>
                {c.key === 'level' ? LEVEL_LABEL[e.level] : c.get(e) ?? ''}
              </span>
            ))}
          </button>
        )}
      />
      <div className="data-foot">
        <span>
          {shown.length.toLocaleString()} of {entries.length.toLocaleString()} lines{entries.length >= RETAIN ? ` (the newest ${RETAIN.toLocaleString()} are kept)` : ''}
        </span>
        <span className="muted">Click a line for details.</span>
      </div>

      {selected && <LogDetails entry={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

function useNarrow(): boolean {
  return useMedia('(max-width: 720px)');
}

function LogDetails({ entry, onClose }: { entry: LogEntry; onClose: () => void }) {
  const { toast } = useFeedback();
  const rows: [string, string | undefined][] = [
    ['Time', entry.time],
    ['Since boot', entry.monotonic !== undefined ? `${entry.monotonic.toFixed(6)} s` : undefined],
    ['Level', entry.level],
    ['Facility', entry.facility],
    ['Process', entry.process ? `${entry.process}${entry.pid ? ` [${entry.pid}]` : ''}` : undefined],
    ['Context', entry.context],
    ['Message ID', entry.msgid],
  ];
  return (
    <div className="log-details">
      <div className="log-details-head">
        <b>Line details</b>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => navigator.clipboard.writeText(entry.raw).then(() => toast({ kind: 'success', title: 'Line copied' }), () => toast({ kind: 'danger', title: 'Couldn’t copy' }))}
        >
          <Icon name="copy" /> Copy line
        </button>
        <button type="button" className="btn btn--sm btn--ghost btn--icon" onClick={onClose} aria-label="Close details">
          <Icon name="x" />
        </button>
      </div>
      <dl className="kv">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="kv-pair">
              <dt>{k}</dt>
              <dd className="mono">{v}</dd>
            </div>
          ))}
      </dl>
      <pre className="log-details-msg">{entry.message}</pre>
      {entry.extras && <pre className="log-details-json">{JSON.stringify(entry.extras, null, 2)}</pre>}
    </div>
  );
}

/** Columns for /var/log/messages. */
export const SYSLOG_COLUMNS: LogColumn[] = [
  { key: 'time', label: 'Time', width: '88px', get: (e) => shortTime(e) },
  { key: 'level', label: 'Level', width: '52px', get: (e) => e.level },
  { key: 'process', label: 'Process', width: 'minmax(80px, 160px)', get: (e) => e.process ?? e.context, wide: true },
  { key: 'msgid', label: 'Message ID', width: 'minmax(80px, 170px)', get: (e) => e.msgid, wide: true },
  { key: 'message', label: 'Message', width: 'minmax(0, 1fr)', get: (e) => (e.extras ? `${e.message} ${JSON.stringify(e.extras)}` : e.message) },
];

/** Columns for the kernel log. */
export const DMESG_COLUMNS: LogColumn[] = [
  { key: 'time', label: 'Since boot', width: '100px', get: (e) => (e.monotonic !== undefined ? e.monotonic.toFixed(3) : '') },
  { key: 'level', label: 'Level', width: '58px', get: (e) => e.level },
  { key: 'facility', label: 'Facility', width: '64px', get: (e) => e.facility, wide: true },
  { key: 'context', label: 'Source', width: 'minmax(80px, 170px)', get: (e) => e.context, wide: true, optional: true },
  { key: 'message', label: 'Message', width: 'minmax(0, 1fr)', get: (e) => e.message },
];
