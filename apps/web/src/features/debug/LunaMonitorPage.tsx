import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { TvName } from '../../components/TvName';
import { PageHeader } from '../../components/PageHeader';
import { NeedsDevice } from '../../components/NeedsDevice';
import { Alert } from '../../components/Alert';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useDevices } from '../../devices/useDevices';
import type { SavedDevice } from '../../devices/store';
import { saveBlob } from '../files/transfer';
import { MonitorCapture, monitorMatches, parseMonitorLine, parseMonitorQuery, type CallEntry, type MonitorItem } from './parse';
import { useLogStream } from './useLogStream';
import { VirtualList } from './VirtualList';

/** Raw lines kept for "Save", by size (the calls list keeps its own 20 000 calls). */
const MAX_RAW_BYTES = 32 * 1024 * 1024;
const ROW = 26;

/** Luna monitor (LsMonitorComponent): `ls-monitor -j` grouped into calls and their replies. */
export function LunaMonitorPage() {
  const { active } = useDevices();
  return (
    <>
      <PageHeader
        eyebrow="Debug"
        title="Luna"
        accent="monitor"
        sub={<>Every call on the luna service bus{active ? <> of <TvName device={active} /></> : null}, with its replies — what apps ask the system and what it answers.</>}
      />
      <div className="grid">
        <NeedsDevice device={active}>{active && <Monitor key={active.id} device={active} />}</NeedsDevice>
      </div>
    </>
  );
}

function Monitor({ device }: { device: SavedDevice }) {
  const { toast } = useFeedback();
  const capture = useRef(new MonitorCapture());
  const raw = useRef<string[]>([]);
  const rawBytes = useRef(0);
  const keepRaw = (l: string) => {
    raw.current.push(l);
    rawBytes.current += l.length;
    let drop = 0;
    while (rawBytes.current > MAX_RAW_BYTES && drop < raw.current.length - 1) rawBytes.current -= raw.current[drop++]!.length;
    if (drop) raw.current.splice(0, drop);
  };
  const [version, setVersion] = useState(0);
  const [source, setSource] = useState<'none' | 'live' | 'file'>('none');
  const [fileName, setFileName] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const frame = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = device.username === 'root';

  const publish = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setVersion((v) => v + 1);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onLines = useCallback(
    (lines: string[]) => {
      for (const l of lines) {
        const m = parseMonitorLine(l);
        if (!m) continue;
        keepRaw(l);
        capture.current.add(m);
      }
      publish();
    },
    [publish],
  );
  const { state, start, stop, ready } = useLogStream(device, 'lsmonitor', onLines);
  const capturing = state.phase === 'running' && source === 'live';

  const reset = () => {
    capture.current = new MonitorCapture();
    raw.current = [];
    rawBytes.current = 0;
    setSelectedId(null);
    setVersion((v) => v + 1);
  };

  const begin = () => {
    reset();
    setSource('live');
    start();
  };

  const openFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    stop();
    try {
      const text = await file.text();
      reset();
      let bad = 0;
      for (const l of text.split('\n')) {
        if (!l.trim()) continue;
        const m = parseMonitorLine(l);
        if (!m) {
          bad++;
          continue;
        }
        keepRaw(l);
        capture.current.add(m);
      }
      setSource('file');
      setFileName(file.name);
      setVersion((v) => v + 1);
      if (bad) toast({ kind: 'warning', title: `${bad} lines skipped`, text: 'They weren’t ls-monitor JSON messages.' });
    } catch (err) {
      toast({ kind: 'danger', title: 'Couldn’t open the file', text: describeError(err).message });
    }
  };

  const save = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    saveBlob(new Blob([`${raw.current.join('\n')}\n`], { type: 'application/x-ndjson' }), `${device.name.replace(/[^A-Za-z0-9._-]+/g, '-')}-ls-monitor-${stamp}.jsonl`);
  };

  const parsedQuery = useMemo(() => parseMonitorQuery(query), [query]);
  // `version` changes whenever the capture does (it is mutated in place).
  const rows = useMemo(() => capture.current.calls.filter((c) => monitorMatches(c, parsedQuery)), [parsedQuery, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = selectedId !== null ? capture.current.calls.find((c) => c.id === selectedId) ?? null : null;
  const total = capture.current.calls.length;

  return (
    <section className="card col-12 log-card">
      <div className="data-toolbar">
        <div className="data-toolbar-left">
          <div className="input-icon monitor-search">
            <span className="ico"><Icon name="search" /></span>
            <input
              className="input mono"
              type="search"
              placeholder="text  sender:com.webos.app.home  destination:…  -sender:…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter calls (sender:, destination:, - to exclude)"
              spellCheck={false}
            />
          </div>
        </div>
        <div className="data-toolbar-right">
          {source !== 'none' && (
            <span className={`log-status ${capturing ? 'running' : 'ended'}`} role="status">
              <span className="dot" />
              {capturing ? 'Capturing' : source === 'file' ? fileName : 'Stopped'}
            </span>
          )}
          {capturing ? (
            <button type="button" className="btn btn--sm btn--danger" onClick={stop}>
              <Icon name="x" /> Stop
            </button>
          ) : (
            <button type="button" className="btn btn--sm btn--primary" onClick={begin} disabled={!ready || !root} title={root ? undefined : 'Needs a rooted TV'}>
              <Icon name="play" /> {source === 'live' ? 'Capture again' : 'Start capture'}
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => fileInput.current?.click()} disabled={capturing}>
            <Icon name="folder" /> Open…
          </button>
          <input ref={fileInput} type="file" accept=".jsonl,.json,.txt,application/x-ndjson" hidden onChange={openFile} />
          <button type="button" className="btn btn--sm btn--ghost" onClick={save} disabled={!raw.current.length}>
            <Icon name="download" /> Save
          </button>
        </div>
      </div>

      {!root && (
        <Alert kind="info" title="Capturing needs a rooted TV">
          ls-monitor only runs as root. You can still open a capture saved earlier (.jsonl).
        </Alert>
      )}
      {state.phase === 'error' && source === 'live' && <ErrorAlert error={state.error} title="The capture stopped" />}
      {state.dropped > 0 && (
        <Alert kind="warning" title="Some messages were skipped">
          The bus was busier than the bridge forwards ({state.dropped.toLocaleString()} lines skipped). Filtering doesn’t reduce this — it happens before.
        </Alert>
      )}

      <div className={`monitor${selected ? ' has-details' : ''}`}>
        <VirtualList
          items={rows}
          rowHeight={ROW}
          keyOf={(c) => c.id}
          label="Luna calls"
          className="log-list monitor-list"
          header={
            <div className="log-row log-head monitor-row">
              <span>Call</span>
              {!selected && <span className="hide-sm">Sender</span>}
              {!selected && <span className="hide-sm">Payload</span>}
            </div>
          }
          empty={
            <div className="log-empty muted">
              {source === 'none' ? 'Start a capture to watch the bus, or open a saved one.' : total ? 'No calls match the filter.' : capturing ? 'Waiting for calls…' : 'No calls.'}
            </div>
          }
          render={(c) => (
            <button type="button" className={`log-row monitor-row${c.id === selectedId ? ' is-selected' : ''}`} onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}>
              <span className="monitor-name">
                <span className={`call-dot ${c.status}`} role="img" title={STATUS[c.status]} aria-label={STATUS[c.status]} />
                {c.name}
              </span>
              {!selected && <span className="hide-sm">{c.sender}</span>}
              {!selected && <span className="hide-sm mono">{c.information}</span>}
            </button>
          )}
        />
        {selected && <CallDetails entry={selected} onClose={() => setSelectedId(null)} />}
      </div>
      <div className="data-foot">
        <span>
          {rows.length.toLocaleString()} of {total.toLocaleString()} calls
        </span>
        <span className="muted">Filter: words, sender:…, destination:…, put - in front to exclude.</span>
      </div>
    </section>
  );
}

const STATUS: Record<CallEntry['status'], string> = {
  pending: 'No reply yet',
  ok: 'Replied',
  error: 'Replied with an error',
  cancelled: 'Cancelled',
};

const ARROW: Record<string, string> = { call: '→', return: '←', callCancel: '×' };

function CallDetails({ entry, onClose }: { entry: CallEntry; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [entry.id]);
  const msg: MonitorItem | undefined = entry.messages[index] ?? entry.messages[0];
  return (
    <div className="monitor-details" role="region" aria-label="Call details">
      <div className="log-details-head">
        <b className="mono monitor-details-name">{entry.name}</b>
        <span className="spacer" />
        <button type="button" className="btn btn--sm btn--ghost btn--icon" onClick={onClose} aria-label="Close details">
          <Icon name="x" />
        </button>
      </div>
      {entry.skipped ? <p className="muted small">{entry.skipped.toLocaleString()} older replies not kept.</p> : null}
      <ol className="monitor-messages">
        {entry.messages.map((m, i) => (
          <li key={i}>
            <button type="button" className={`monitor-msg${i === index ? ' is-selected' : ''}`} onClick={() => setIndex(i)} aria-pressed={i === index}>
              <span className="monitor-arrow" role="img" aria-label={m.type === 'call' ? 'Call' : m.type === 'return' ? 'Reply' : m.type === 'callCancel' ? 'Cancel' : m.type}>{ARROW[m.type] ?? '•'}</span>
              <span className="mono">{m.information || '(no payload)'}</span>
            </button>
          </li>
        ))}
      </ol>
      {msg && (
        <div className="monitor-msg-detail">
          <dl className="kv">
            <div className="kv-pair"><dt>Type</dt><dd>{msg.type}</dd></div>
            <div className="kv-pair"><dt>Sender</dt><dd className="mono">{msg.sender}</dd></div>
            <div className="kv-pair">
              <dt>Destination</dt>
              <dd className="mono">
                {msg.destination}
                {msg.methodCategory && msg.methodCategory !== '/' ? msg.methodCategory : ''}
                {msg.method ? `/${msg.method}` : ''}
              </dd>
            </div>
          </dl>
          {msg.payload !== undefined && <pre className="log-details-json">{JSON.stringify(msg.payload, null, 2)}</pre>}
          {msg.rawPayload && <pre className="log-details-json">{msg.rawPayload}</pre>}
        </div>
      )}
    </div>
  );
}
