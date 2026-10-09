import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import { CMD_LOG_EVENT, CMD_OUTPUT_EVENT, CmdLog, CmdOutput } from '@lgdm/protocol';
import { useBridge } from '../bridge/BridgeProvider';
import { newOpId, useRpc } from '../bridge/useRpc';
import { describeError } from '../components/ErrorAlert';
import { toTarget } from '../devices/store';
import { useDevices } from '../devices/useDevices';
import { Icon } from '../shell/icons';
import { consoleStore, type ConsoleEntry } from './store';

const PREF_KEY = 'lgdm-console';
const MIN_H = 140;
const DEFAULT_H = 300;

interface Prefs {
  open: boolean;
  height: number;
  showQuiet: boolean;
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<Prefs>;
    return { open: !!p.open, height: Number(p.height) || DEFAULT_H, showQuiet: !!p.showQuiet };
  } catch {
    return { open: false, height: DEFAULT_H, showQuiet: false };
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

/** Feeds `cmd.log` / `cmd.output` events from the bridge into the console store. */
function useConsoleFeed() {
  const { client } = useBridge();
  useEffect(() => {
    if (!client) return;
    const offLog = client.on(CMD_LOG_EVENT, (d) => {
      const e = CmdLog.safeParse(d);
      if (e.success) consoleStore.log(e.data);
    });
    const offOut = client.on(CMD_OUTPUT_EVENT, (d) => {
      const o = CmdOutput.safeParse(d);
      if (o.success) consoleStore.appendManual(o.data.opId, o.data.data);
    });
    return () => {
      offLog();
      offOut();
    };
  }, [client]);
}

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const dur = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function Status({ e }: { e: ConsoleEntry }) {
  if (e.running) return <span className="cons-status is-running"><span className="spinner sm" /> running</span>;
  if (e.cancelled) return <span className="cons-status is-warn">stopped</span>;
  if (e.error) return <span className="cons-status is-err" title={e.error}>failed</span>;
  if (e.exitCode === 0 || (e.exitCode === undefined && !e.error)) return <span className="cons-status is-ok">{e.exitCode === 0 ? 'exit 0' : 'done'}</span>;
  if (e.exitCode === null) return <span className="cons-status">closed</span>;
  return <span className="cons-status is-err">exit {e.exitCode}</span>;
}

function Entry({ e, expanded, onToggle }: { e: ConsoleEntry; expanded: boolean; onToggle: () => void }) {
  const hasOutput = !!(e.output || e.error);
  const show = e.source === 'manual' || expanded;
  return (
    <div className={`cons-entry is-${e.source}${e.running ? ' is-running' : ''}`}>
      <button type="button" className="cons-line" onClick={onToggle} aria-expanded={hasOutput ? show : undefined} disabled={!hasOutput && e.source === 'bridge'}>
        <span className="cons-time">{time(e.startedAt)}</span>
        <span className="cons-target">{e.target}</span>
        <span className="cons-cmd">
          <span className="cons-prompt">{e.kind === 'sftp' || e.kind === 'tunnel' || e.kind === 'http' ? '⇄' : '$'}</span> {e.command}
        </span>
        <span className="cons-meta">
          <Status e={e} />
          <span className="cons-dur">{dur(e.durationMs)}</span>
        </span>
      </button>
      {show && hasOutput && (
        <pre className="cons-output">
          {e.output}
          {e.error && <span className="cons-error">{e.output ? '\n' : ''}{e.error}</span>}
        </pre>
      )}
    </div>
  );
}

/**
 * Bottom console: every SSH command the bridge runs for this tab (live and past), and — once "Send commands" is
 * ticked — a prompt to run commands on the active TV directly.
 */
export function ConsoleDock() {
  useConsoleFeed();
  const entries = useSyncExternalStore(consoleStore.subscribe, consoleStore.getSnapshot);
  const { ready, client } = useRpc();
  const { active } = useDevices();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [manual, setManual] = useState(false);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);

  const update = (p: Partial<Prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      savePrefs(next);
      return next;
    });

  const visible = useMemo(() => entries.filter((e) => prefs.showQuiet || !e.quiet), [entries, prefs.showQuiet]);
  const running = entries.filter((e) => e.running);
  const last = visible[visible.length - 1];

  // Keep scrolled to the newest line unless the user scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible, prefs.open]);

  useEffect(() => {
    if (manual && prefs.open) inputRef.current?.focus();
  }, [manual, prefs.open]);

  // Reserve room at the bottom of the page so the dock never covers content.
  useEffect(() => {
    document.documentElement.style.setProperty('--console-h', `${prefs.open ? prefs.height + 44 : 44}px`);
  }, [prefs.open, prefs.height]);

  const prompt = active ? `${active.username}@${active.name}` : 'no TV';
  const canType = manual && ready && !!active && !runningId;

  const run = async () => {
    const command = input.trim();
    if (!command || !client || !active || runningId) return;
    const opId = newOpId();
    setInput('');
    setHistory((h) => [...h.filter((x) => x !== command), command].slice(-100));
    setHistPos(-1);
    stick.current = true;
    consoleStore.startManual(opId, `${active.username}@${active.host}:${active.port}`, command);
    setRunningId(opId);
    try {
      const r = await client.call('cmd.stream', { device: toTarget(active), command, opId }, 30 * 60_000);
      consoleStore.finishManual(opId, r);
    } catch (e) {
      consoleStore.finishManual(opId, { error: describeError(e).message });
    } finally {
      setRunningId(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const stop = () => {
    if (runningId && client) client.call('cmd.cancel', { opId: runningId }).catch(() => {});
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run();
    } else if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault();
      const pos = histPos < 0 ? history.length - 1 : Math.max(0, histPos - 1);
      setHistPos(pos);
      setInput(history[pos]!);
    } else if (e.key === 'ArrowDown' && histPos >= 0) {
      e.preventDefault();
      const pos = histPos + 1;
      if (pos >= history.length) {
        setHistPos(-1);
        setInput('');
      } else {
        setHistPos(pos);
        setInput(history[pos]!);
      }
    }
  };

  const onDocKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'c' && e.ctrlKey && runningId) {
      e.preventDefault();
      stop();
    }
  };

  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = prefs.height;
    const max = Math.max(MIN_H, window.innerHeight - 160);
    const move = (ev: globalThis.PointerEvent) => update({ height: Math.min(max, Math.max(MIN_H, startH + startY - ev.clientY)) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <section className={`console-dock${prefs.open ? ' is-open' : ''}`} aria-label="Console" onKeyDown={onDocKey}>
      {prefs.open && <div className="cons-resize" onPointerDown={startResize} role="separator" aria-orientation="horizontal" aria-label="Resize console" />}
      <div className="cons-bar">
        <button type="button" className="cons-toggle" onClick={() => update({ open: !prefs.open })} aria-expanded={prefs.open}>
          <Icon name="terminal" />
          <span className="cons-title">Console</span>
          {running.length > 0 ? (
            <span className="badge primary dot">{running.length} running</span>
          ) : (
            <span className="cons-count">{visible.length}</span>
          )}
          {!prefs.open && last && <span className="cons-last mono">$ {last.command}</span>}
          <Icon name="chevRight" className={`cons-chev${prefs.open ? ' is-open' : ''}`} strokeWidth={2} />
        </button>
        <div className="cons-tools">
          <label className="check" title="Type commands and run them on the active TV">
            <input
              type="checkbox"
              checked={manual}
              onChange={(e) => {
                setManual(e.target.checked);
                if (e.target.checked && !prefs.open) update({ open: true });
              }}
            />
            <span className="box" />
            <span className="cons-check-label">Send commands</span>
          </label>
          {prefs.open && (
            <>
              <label className="check cons-quiet" title="Show routine background reads such as app icons">
                <input type="checkbox" checked={prefs.showQuiet} onChange={(e) => update({ showQuiet: e.target.checked })} />
                <span className="box" />
                <span className="cons-check-label">Background reads</span>
              </label>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => consoleStore.clear()} disabled={!entries.length}>
                Clear
              </button>
            </>
          )}
        </div>
      </div>

      {prefs.open && (
        <div className="cons-body" style={{ height: prefs.height }}>
          <div
            className="cons-list"
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {visible.length === 0 ? (
              <div className="cons-empty">
                Commands the bridge runs on your TV appear here — listing apps, installs, file transfers. Tick <b>Send commands</b> to
                type your own.
              </div>
            ) : (
              visible.map((e) => (
                <Entry
                  key={e.id}
                  e={e}
                  expanded={expanded.has(e.id) || (!!e.error && !e.quiet)}
                  onToggle={() =>
                    setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(e.id)) n.delete(e.id);
                      else n.add(e.id);
                      return n;
                    })
                  }
                />
              ))
            )}
          </div>
          {manual && (
            <div className="cons-input-row">
              {!ready || !active ? (
                <span className="cons-hint">{!ready ? 'Connect the bridge to send commands.' : 'Choose a TV to send commands to.'}</span>
              ) : (
                <>
                  <label className="cons-ps1 mono" htmlFor="console-input">{prompt} $</label>
                  <input
                    id="console-input"
                    ref={inputRef}
                    className="cons-input mono"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKey}
                    disabled={!canType}
                    placeholder={runningId ? 'Running… (Ctrl+C to stop)' : 'Type a command and press Enter — e.g. uname -a'}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`Command to run on ${active.name}`}
                  />
                  {runningId ? (
                    <button type="button" className="btn btn--sm btn--soft-danger" onClick={stop}>
                      Stop
                    </button>
                  ) : (
                    <button type="button" className="btn btn--sm btn--soft-primary" onClick={run} disabled={!input.trim()}>
                      Run
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {manual && ready && active && (
            <div className="cons-warning">
              Commands run directly on {active.name} as <span className="mono">{active.username}</span>. There is no undo.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
