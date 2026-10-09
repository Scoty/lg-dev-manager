import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import '@xterm/xterm/css/xterm.css';
import { PageHeader } from '../../components/PageHeader';
import { NeedsDevice } from '../../components/NeedsDevice';
import { Dropdown } from '../../components/Dropdown';
import { Alert } from '../../components/Alert';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useRpc } from '../../bridge/useRpc';
import { useDevices } from '../../devices/useDevices';
import { toTarget, type SavedDevice } from '../../devices/store';
import { modelLabel } from '../../devices/model';
import { terminals, type Tab } from './store';

/** Rough character cell of 13px JetBrains Mono, for sizing a shell before its terminal is on screen. */
const CELL = { w: 7.8, h: 17 };

/**
 * Terminal (TerminalComponent / PtyComponent / DumbComponent in the original): tabs of interactive shells on any
 * saved TV, kept open while you use other pages.
 */
export function TerminalPage() {
  useSyncExternalStore(terminals.subscribe, terminals.getSnapshot);
  const { devices, active } = useDevices();
  const { client, ready } = useRpc();
  const { toast } = useFeedback();
  // A state-backed ref: the stage appears only once devices have loaded, and the effects must see that.
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const stage = { current: stageEl };
  const tabs = terminals.list;
  const current = terminals.active;

  // Tabs from an earlier bridge connection can't be talked to any more.
  useEffect(() => terminals.markDisconnected(ready ? client : null), [client, ready]);

  // Show the active tab's terminal in the stage, fitted to it.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const host = current?.term ? current.host : null;
    if (host && host.parentElement !== el) el.replaceChildren(host);
    if (!host) el.replaceChildren();
    if (current?.term && current.fit) {
      try {
        current.fit.fit();
      } catch {
        /* not laid out yet */
      }
      current.term.focus();
    }
    // Only when the shown terminal changes — not on every render (that would steal focus from the tab bar).
  }, [stageEl, current?.key, current?.term]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const t = terminals.active;
      if (t?.fit && t.host.parentElement === el) {
        try {
          t.fit.fit();
        } catch {
          /* hidden */
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [stageEl]);

  const size = () => {
    if (current?.term) return { rows: current.term.rows, cols: current.term.cols };
    const r = stage.current?.getBoundingClientRect();
    return {
      rows: Math.max(10, Math.floor(((r?.height ?? 400) - 16) / CELL.h)),
      cols: Math.max(40, Math.floor(((r?.width ?? 800) - 16) / CELL.w)),
    };
  };

  const openOn = async (d: SavedDevice, pty = true) => {
    if (!client) return;
    const tab = await terminals.open(client, { deviceId: d.id, deviceName: d.name, device: toTarget(d), ...size(), pty });
    if (tab.state === 'failed') toast({ kind: 'danger', title: `Couldn’t open a terminal on ${d.name}`, text: tab.note });
  };

  const others = (devices ?? []).filter((d) => d.id !== active?.id);

  return (
    <>
      <PageHeader
        eyebrow="Device"
        title="Terminal"
        sub={
          <>
            A shell on your TV. Tabs stay open while you use other pages; closing or reloading this browser tab ends them. Copy with{' '}
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>.
          </>
        }
      />
      <div className="grid">
        <NeedsDevice device={active}>
          <section className="card col-12 term-card">
            <div className="term-bar">
              <div className="term-tabs" role="tablist" aria-label="Terminals">
                {tabs.map((t) => (
                  <div key={t.key} className={`term-tab${t.key === current?.key ? ' is-active' : ''}`}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={t.key === current?.key}
                      className="term-tab-btn"
                      onClick={() => terminals.activate(t.key)}
                      title={`${t.deviceName} — ${t.title}`}
                    >
                      <span className={`term-dot is-${t.state}`} aria-hidden="true" />
                      <span className="term-tab-title">{t.deviceName}</span>
                      {!t.pty && t.state !== 'connecting' && <span className="term-tab-tag">simple</span>}
                    </button>
                    <button type="button" className="term-tab-close" onClick={() => terminals.close(t.key)} aria-label={`Close ${t.deviceName} terminal`}>
                      <Icon name="x" strokeWidth={2} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="term-new">
                <button type="button" className="btn btn--sm btn--soft-primary" onClick={() => active && openOn(active)} disabled={!active || !ready} title={active ? `New terminal on ${active.name}` : undefined}>
                  <Icon name="plus" /> <span className="hide-sm">New terminal</span>
                </button>
                <Dropdown
                  label="More terminal options"
                  menuClassName="dd-menu--compact"
                  floating
                  trigger={({ toggle, ...aria }) => (
                    <button type="button" className="btn btn--icon btn--sm btn--ghost" onClick={toggle} aria-label="More terminal options" disabled={!ready} {...aria}>
                      <Icon name="chevDown" />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      {others.length > 0 && <div className="dd-section-label">Open on another TV</div>}
                      {others.map((d) => (
                        <button key={d.id} type="button" role="menuitem" className="dd-menu-item" onClick={() => (close(), openOn(d))}>
                          <Icon name="tv" />
                          <span className="dd-menu-text">
                            <span>{d.name}</span>
                            <span className="dd-menu-sub mono">{[modelLabel(d.info?.modelName), d.host].filter(Boolean).join(' · ')}</span>
                          </span>
                        </button>
                      ))}
                      {others.length > 0 && <div className="dd-divider" />}
                      <button type="button" role="menuitem" className="dd-menu-item" disabled={!active} onClick={() => (close(), active && openOn(active, false))}>
                        <Icon name="terminal" />
                        <span className="dd-menu-text">
                          <span>Simple shell (no PTY)</span>
                          <span className="dd-menu-sub">Command and output only</span>
                        </span>
                      </button>
                    </>
                  )}
                </Dropdown>
              </div>
            </div>

            <div className="term-body">
              {!current ? (
                <div className="empty-state">
                  <div className="empty-icon"><Icon name="terminal" /></div>
                  <h3>No terminal open</h3>
                  <p>Open a shell on {active ? <b>{active.name}</b> : 'a TV'} to run commands on it.</p>
                  {active && (
                    <button type="button" className="btn btn--primary" onClick={() => openOn(active)} disabled={!ready}>
                      <Icon name="terminal" /> Open a terminal on {active.name}
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {current.state !== 'open' && current.state !== 'connecting' && <EndedBanner tab={current} />}
                  {current.state === 'connecting' && !current.term && (
                    <div className="empty-state"><span className="spinner" /><p>Connecting to {current.deviceName}…</p></div>
                  )}
                  {!current.pty && current.state !== 'connecting' && current.state !== 'failed' && <DumbShell tab={current} />}
                  <div ref={setStageEl} className={`term-stage${current.term ? '' : ' is-empty'}`} />
                </>
              )}
            </div>
          </section>
        </NeedsDevice>
      </div>
    </>
  );
}

function EndedBanner({ tab }: { tab: Tab }) {
  const { client, ready } = useRpc();
  const kind = tab.state === 'exited' ? 'info' : tab.state === 'failed' ? 'danger' : 'warning';
  const title = tab.state === 'exited' ? 'The shell has ended' : tab.state === 'failed' ? `Couldn’t open a shell on ${tab.deviceName}` : 'Disconnected';
  return (
    <div className="term-banner">
      <Alert
        kind={kind}
        title={title}
        action={
          <button type="button" className="btn btn--sm btn--ghost" disabled={!ready || !client} onClick={() => client && terminals.restart(tab, client)}>
            <Icon name="refresh" /> {tab.state === 'failed' ? 'Try again' : 'Reconnect'}
          </button>
        }
      >
        {tab.note}
        {tab.state === 'failed' && <div className="alert-hint">Make sure the TV is on. Right after it starts, SSH can take a minute or two to come up.</div>}
      </Alert>
    </div>
  );
}

/** A shell without a PTY: type a command, see its output and exit code (DumbComponent in the original). */
function DumbShell({ tab }: { tab: Tab }) {
  const [cmd, setCmd] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [pos, setPos] = useState(-1);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const busy = tab.dumb.length > 0 && tab.dumb[tab.dumb.length - 1]!.status === undefined;

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [tab.dumb]);
  useEffect(() => input.current?.focus(), [tab.key]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!cmd.trim()) return;
    terminals.sendDumb(tab, cmd);
    setHistory((h) => [...h.filter((x) => x !== cmd.trim()), cmd.trim()].slice(-50));
    setPos(-1);
    setCmd('');
  };

  return (
    <div className="term-dumb">
      <Alert kind="info" title="Simple shell">
        This shell has no terminal (PTY), so full-screen programs like <span className="mono">top</span> or <span className="mono">vi</span> won’t work.
      </Alert>
      <div className="term-dumb-log" ref={log} aria-live="polite">
        {tab.dumb.length === 0 && <div className="muted">Type a command below.</div>}
        {tab.dumb.map((e) => (
          <div key={e.id} className="term-dumb-entry">
            <div className="term-dumb-cmd">
              <span className="cons-ps1">$</span> {e.input}
              <span className={`term-dumb-status${e.status === undefined ? '' : e.status === 0 ? ' is-ok' : ' is-err'}`}>
                {e.status === undefined ? <span className="spinner sm" /> : `exit ${e.status}`}
              </span>
            </div>
            {e.output && <pre className="term-dumb-out">{e.output.replace(/\n$/, '')}</pre>}
          </div>
        ))}
      </div>
      <form className="term-dumb-form" onSubmit={send}>
        <span className="cons-ps1" aria-hidden="true">$</span>
        <input
          ref={input}
          className="input mono"
          aria-label="Command"
          value={cmd}
          disabled={tab.state !== 'open'}
          placeholder={busy ? 'Waiting for the last command…' : 'Command'}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const p = pos < 0 ? history.length - 1 : Math.max(0, pos - 1);
              setPos(p);
              setCmd(history[p]!);
            } else if (e.key === 'ArrowDown' && pos >= 0) {
              e.preventDefault();
              const p = pos + 1;
              if (p >= history.length) {
                setPos(-1);
                setCmd('');
              } else {
                setPos(p);
                setCmd(history[p]!);
              }
            }
          }}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" className="btn btn--primary btn--sm" disabled={tab.state !== 'open' || !cmd.trim()}>
          Run
        </button>
      </form>
    </div>
  );
}
