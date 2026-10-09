import { useMemo, useState, type FormEvent } from 'react';
import { TvName } from '../../components/TvName';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PmLogContext, type PmLogLevel } from '@lgdm/protocol';
import { PageHeader } from '../../components/PageHeader';
import { NeedsDevice } from '../../components/NeedsDevice';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useRpc } from '../../bridge/useRpc';
import { useDevices } from '../../devices/useDevices';
import { toTarget, type SavedDevice } from '../../devices/store';
import { NeedsRoot } from './LogPages';

/** LOG_LEVELS in pmlog/control/control.component.ts. */
const LEVELS: { level: PmLogLevel; label: string }[] = [
  { level: 'none', label: 'None' },
  { level: 'debug', label: 'Debug' },
  { level: 'info', label: 'Info' },
  { level: 'notice', label: 'Notice' },
  { level: 'warning', label: 'Warning' },
  { level: 'err', label: 'Error' },
  { level: 'crit', label: 'Critical' },
  { level: 'alert', label: 'Alert' },
  { level: 'emerg', label: 'Emergency' },
];

/** Log levels (PmLogControlComponent + SetContextComponent): what each PmLog context writes to the system log. */
export function PmLogPage() {
  const { active } = useDevices();
  return (
    <>
      <PageHeader
        eyebrow="Debug"
        title="Log"
        accent="levels"
        sub={<>How much each PmLog context writes to the <Link to="/debug/logs">system log</Link>{active ? <> on <TvName device={active} /></> : null}. Changes last until the TV restarts.</>}
      />
      <div className="grid">
        <NeedsDevice device={active}>
          {active && (
            <NeedsRoot device={active} what="Setting log levels">
              <Levels key={active.id} device={active} />
            </NeedsRoot>
          )}
        </NeedsDevice>
      </div>
    </>
  );
}

function Levels({ device }: { device: SavedDevice }) {
  const { ready, call } = useRpc();
  const { toast } = useFeedback();
  const qc = useQueryClient();
  const key = ['pmlog', device.id];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => (await call('pmlog.show', { device: toTarget(device) })).contexts,
    enabled: ready,
  });
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [ctx, setCtx] = useState('');
  const [ctxLevel, setCtxLevel] = useState<PmLogLevel>('debug');

  const contexts = q.data ?? [];
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return contexts.filter((c) => !f || c.name.toLowerCase().includes(f));
  }, [contexts, filter]);

  const set = async (context: string, level: PmLogLevel) => {
    setBusy(context);
    try {
      const { changed } = await call('pmlog.set', { device: toTarget(device), context, level });
      // reflectChanges: update the contexts PmLogCtl says it changed (and add new ones).
      qc.setQueryData<{ name: string; level: string }[]>(key, (old = []) => {
        const next = old.map((c) => (changed.includes(c.name) ? { ...c, level } : c));
        for (const n of changed) if (!next.some((c) => c.name === n)) next.push({ name: n, level });
        return next;
      });
      if (!changed.length) toast({ kind: 'warning', title: 'Nothing changed', text: `PmLogCtl didn’t report any change for ${context}.` });
      else if (context === '*') toast({ kind: 'success', title: `All contexts set to ${level}` });
    } catch (e) {
      toast({ kind: 'danger', title: 'Couldn’t set the level', text: describeError(e).message });
    } finally {
      setBusy(null);
    }
  };

  const valid = PmLogContext.safeParse(ctx.trim()).success;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    await set(ctx.trim(), ctxLevel);
    setCtx('');
  };

  return (
    <>
      <section className="card col-8">
        <div className="data-toolbar">
          <div className="data-toolbar-left">
            <div className="input-icon">
              <span className="ico"><Icon name="search" /></span>
              <input className="input" type="search" placeholder="Filter contexts…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter contexts" />
            </div>
          </div>
          <div className="data-toolbar-right">
            {q.data && <span className="muted count-label">{shown.length} of {contexts.length}</span>}
            <button type="button" className="btn btn--icon btn--ghost" onClick={() => q.refetch()} disabled={!ready || q.isFetching} aria-label="Reload">
              <Icon name="refresh" />
            </button>
          </div>
        </div>
        {q.error ? (
          <ErrorAlert error={q.error} title="Couldn’t read the log levels" action={<button type="button" className="btn btn--sm btn--ghost" onClick={() => q.refetch()}>Retry</button>} />
        ) : !q.data ? (
          <div className="empty-state"><span className="spinner" /><p>Reading PmLog contexts…</p></div>
        ) : (
          <div className="table-scroll">
            <table className="data-table pmlog-table">
              <thead>
                <tr>
                  <th>Context</th>
                  <th>Level</th>
                </tr>
              </thead>
              <tbody>
                <tr className="pmlog-all">
                  <td>
                    <label htmlFor="pmlog-all"><b>All contexts</b> <span className="muted">(sets every context)</span></label>
                  </td>
                  <td>
                    {/* Always "Choose…": picking the level that is already shown must still apply it to every context. */}
                    <select id="pmlog-all" className="select select--sm" value="" disabled={busy !== null} onChange={(e) => e.target.value && set('*', e.target.value as PmLogLevel)}>
                      <option value="">Choose…</option>
                      {LEVELS.map((l) => (
                        <option key={l.level} value={l.level}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
                {shown.map((c) => (
                  <tr key={c.name}>
                    <td className="mono">
                      <label htmlFor={`pmlog-${c.name}`}>{c.name}</label>
                    </td>
                    <td>
                      <LevelSelect id={`pmlog-${c.name}`} value={c.level} disabled={busy !== null} onChange={(l) => set(c.name, l)} />
                      {busy === c.name && <span className="spinner sm" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card col-4">
        <div className="card-head">
          <div className="card-title-wrap">
            <span className="eyebrow">PmLogCtl</span>
            <h2 className="card-title">Set a context</h2>
          </div>
        </div>
        <form className="stack" onSubmit={submit}>
          <div className="field">
            <label className="field-label" htmlFor="pmlog-ctx">Context</label>
            <input id="pmlog-ctx" className={`input mono${ctx && !valid ? ' is-invalid' : ''}`} placeholder="* for all" value={ctx} onChange={(e) => setCtx(e.target.value)} autoComplete="off" spellCheck={false} />
            {ctx && !valid && <span className="field-error">Letters, digits and . _ - &lt; &gt; * only.</span>}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="pmlog-level">Level</label>
            <LevelSelect id="pmlog-level" value={ctxLevel} onChange={setCtxLevel} />
          </div>
          <button type="submit" className="btn btn--primary" disabled={!ready || !valid || busy !== null}>
            <Icon name="check" /> Set level
          </button>
          <p className="muted small">For contexts that aren’t listed yet, e.g. an app’s own context. “Debug” logs the most, “None” turns a context off.</p>
        </form>
      </section>
    </>
  );
}

function LevelSelect({ id, value, onChange, disabled }: { id: string; value: string; onChange: (l: PmLogLevel) => void; disabled?: boolean }) {
  const known = LEVELS.some((l) => l.level === value);
  return (
    <select id={id} className="select select--sm" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as PmLogLevel)}>
      {!known && <option value={value}>{value}</option>}
      {LEVELS.map((l) => (
        <option key={l.level} value={l.level}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
