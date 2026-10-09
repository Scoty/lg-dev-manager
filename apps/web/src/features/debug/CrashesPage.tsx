import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CrashReportFile } from '@lgdm/protocol';
import { PageHeader } from '../../components/PageHeader';
import { NeedsDevice } from '../../components/NeedsDevice';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { Alert } from '../../components/Alert';
import { Modal } from '../../components/Modal';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useRpc } from '../../bridge/useRpc';
import { useDevices } from '../../devices/useDevices';
import { toTarget, type SavedDevice } from '../../devices/store';
import { saveBlob } from '../files/transfer';
import { fmtBytes } from '../info/shots';
import { parseCrashName } from './parse';

/** Crash reports (CrashesComponent + crash DetailsComponent). Works for Developer Mode logins too. */
export function CrashesPage() {
  const { active } = useDevices();
  return (
    <>
      <PageHeader
        eyebrow="Debug"
        title="Crash"
        accent="reports"
        sub={<>When a native app or service crashes{active ? <> on <b>{active.name}</b></> : null}, its report shows up here. They are kept in the TV’s /tmp, so a restart clears them.</>}
      />
      <div className="grid">
        <NeedsDevice device={active}>{active && <Crashes key={active.id} device={active} />}</NeedsDevice>
      </div>
    </>
  );
}

type Report = CrashReportFile & ReturnType<typeof parseCrashName>;

function Crashes({ device }: { device: SavedDevice }) {
  const { ready, call } = useRpc();
  const { confirm, toast } = useFeedback();
  const qc = useQueryClient();
  const key = ['crashes', device.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => call('crashes.list', { device: toTarget(device) }),
    enabled: ready,
  });
  const [open, setOpen] = useState<Report | null>(null);
  const reports = useMemo<Report[]>(() => (q.data?.reports ?? []).map((r) => ({ ...r, ...parseCrashName(r.name) })), [q.data]);

  const download = async (r: Report, loaded?: { text: string; truncated: boolean }) => {
    try {
      const { text, truncated } = loaded ?? (await call('crashes.read', { device: toTarget(device), path: r.path }, 60_000));
      saveBlob(new Blob([`${text}\n`], { type: 'text/plain' }), `${r.saveName}.txt`);
      if (truncated) toast({ kind: 'warning', title: 'Saved the first 2 MB only', text: 'The report is longer; download the whole file from the Files page.' });
    } catch (e) {
      toast({ kind: 'danger', title: 'Couldn’t read the crash report', text: describeError(e).message });
    }
  };

  const remove = async (r: Report) => {
    const ok = await confirm({
      title: 'Delete this crash report?',
      message: (
        <>
          <p className="mono">{r.title}</p>
          <p>It is deleted from the TV. This can’t be undone.</p>
        </>
      ),
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await call('crashes.delete', { device: toTarget(device), path: r.path });
      if (open?.path === r.path) setOpen(null);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast({ kind: 'danger', title: 'Couldn’t delete the crash report', text: describeError(e).message });
    }
  };

  return (
    <section className="card col-12">
      <div className="data-toolbar">
        <div className="data-toolbar-left">
          {q.data?.dir && <span className="muted mono small">{q.data.dir}</span>}
        </div>
        <div className="data-toolbar-right">
          {q.data && <span className="muted count-label">{reports.length} {reports.length === 1 ? 'report' : 'reports'}</span>}
          <button type="button" className="btn btn--icon btn--ghost" onClick={() => q.refetch()} disabled={!ready || q.isFetching} aria-label="Reload">
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      {q.error ? (
        <ErrorAlert error={q.error} title="Couldn’t find crash reports" action={<button type="button" className="btn btn--sm btn--ghost" onClick={() => q.refetch()}>Retry</button>} />
      ) : !q.data ? (
        <div className="empty-state"><span className="spinner" /><p>Looking for crash reports…</p></div>
      ) : reports.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Icon name="check" /></div>
          <h3>No crash reports</h3>
          <p>If a native application crashes, its crash report will be available here.</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table crash-table">
            <thead>
              <tr>
                <th>Crash</th>
                <th className="hide-sm">When</th>
                <th className="hide-sm files-num">Size</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.path}>
                  <td>
                    <button type="button" className="crash-open" onClick={() => setOpen(r)}>
                      <span className="crash-title">{r.title}</span>
                      {r.summary && <span className="crash-summary mono">{r.summary}</span>}
                    </button>
                  </td>
                  <td className="hide-sm nowrap">{r.mtime ? new Date(r.mtime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td>
                  <td className="hide-sm files-num nowrap">{fmtBytes(r.size)}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(r)}>
                        View
                      </button>
                      <button type="button" className="btn btn--sm btn--ghost btn--icon" onClick={() => download(r)} aria-label={`Download ${r.title}`} title="Download">
                        <Icon name="download" />
                      </button>
                      {r.writable && (
                        <button type="button" className="btn btn--sm btn--ghost btn--icon btn--danger-ghost" onClick={() => remove(r)} aria-label={`Delete ${r.title}`} title="Delete">
                          <Icon name="trash" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <CrashDialog device={device} report={open} onClose={() => setOpen(null)} onDownload={(loaded) => download(open, loaded)} />}
    </section>
  );
}

function CrashDialog({
  device,
  report,
  onClose,
  onDownload,
}: {
  device: SavedDevice;
  report: Report;
  onClose: () => void;
  onDownload: (loaded: { text: string; truncated: boolean }) => void;
}) {
  const { ready, call } = useRpc();
  const { toast } = useFeedback();
  const q = useQuery({
    queryKey: ['crash', device.id, report.path],
    queryFn: () => call('crashes.read', { device: toTarget(device), path: report.path }, 60_000),
    enabled: ready,
    staleTime: Infinity,
  });
  const copy = () =>
    q.data &&
    navigator.clipboard.writeText(q.data.text).then(
      () => toast({ kind: 'success', title: 'Crash report copied' }),
      () => toast({ kind: 'danger', title: 'Couldn’t copy' }),
    );
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={report.title}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={copy} disabled={!q.data}>
            <Icon name="copy" /> Copy
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => q.data && onDownload(q.data)} disabled={!q.data}>
            <Icon name="download" /> Download
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {report.summary && <p className="muted mono small">{report.summary}</p>}
      {q.error ? (
        <ErrorAlert error={q.error} title="Couldn’t read the crash report" />
      ) : !q.data ? (
        <div className="empty-state"><span className="spinner" /></div>
      ) : (
        <>
          {q.data.truncated && <Alert kind="warning" title="Shortened">This report is very long; only the first 2 MB are shown. Download it from the Files page for the whole file.</Alert>}
          <pre className="crash-text">{q.data.text || '(empty)'}</pre>
        </>
      )}
    </Modal>
  );
}
