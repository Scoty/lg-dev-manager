import { useMemo, useRef, useState, type DragEvent } from 'react';
import type { AppInfo } from '@lgdm/protocol';
import { PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Dropdown } from '../../components/Dropdown';
import { NeedsDevice } from '../../components/NeedsDevice';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useDevices } from '../../devices/useDevices';
import type { SavedDevice } from '../../devices/store';
import { AppIcon } from './AppIcon';
import { useAppOperations } from './operations';
import { useInstalledApps, useStorage } from './queries';

const fmtKb = (kb: number) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);

function StorageBar({ device }: { device: SavedDevice }) {
  const { data } = useStorage(device);
  if (!data) return null;
  const pct = Math.round((data.used / Math.max(1, data.total)) * 100);
  return (
    <div className="storage-bar" title="Developer partition (/media/developer)">
      <Icon name="disk" />
      <span>
        <b>{fmtKb(data.available)}</b> free of {fmtKb(data.total)}
      </span>
      <div className="progress thin">
        <div className={`progress-fill${pct > 90 ? ' danger' : pct > 75 ? ' warning' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function InstalledAppsPage() {
  const { active } = useDevices();
  const { data: apps, error, isLoading, isFetching, refetch } = useInstalledApps(active);
  const { install, remove, launch, busy, dialog } = useAppOperations(active, apps);
  const { toast } = useFeedback();
  const [query, setQuery] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const hasSystem = !!apps?.some((a) => a.systemApp);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (apps ?? [])
      .filter((a) => showSystem || !a.systemApp)
      .filter((a) => !q || (a.title ?? '').toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
      .sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id));
  }, [apps, query, showSystem]);

  const onFiles = (files: FileList | null) => {
    const list = [...(files ?? [])];
    if (!list.length) return;
    if (list.length > 1) toast({ kind: 'info', title: 'One at a time', text: `Installing ${list[0]!.name} — drop the others after it finishes.` });
    install(list[0]!);
  };

  const dropHandlers = active
    ? {
        onDragEnter: (e: DragEvent) => {
          if (![...e.dataTransfer.types].includes('Files')) return;
          dragDepth.current++;
          setDragging(true);
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        },
        onDragOver: (e: DragEvent) => {
          if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!busy) onFiles(e.dataTransfer.files);
        },
      }
    : {};

  const canInstall = !!active && !busy;

  return (
    <div className="drop-zone-page" {...dropHandlers}>
      <PageHeader
        eyebrow="Apps"
        title="Installed"
        accent="apps"
        sub={active ? <>Apps on <b>{active.name}</b>. Drop an <span className="mono">.ipk</span> anywhere on this page to install it.</> : 'Apps on your TV.'}
        actions={
          active && (
            <>
              <button type="button" className="btn btn--primary" onClick={() => fileRef.current?.click()} disabled={!canInstall}>
                <Icon name="upload" /> Install IPK
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".ipk,application/vnd.debian.binary-package,application/octet-stream"
                hidden
                onChange={(e) => {
                  onFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </>
          )
        }
      />
      <div className="grid">
        <NeedsDevice device={active}>
          <section className="card col-12">
            <div className="data-toolbar">
              <div className="data-toolbar-left">
                <div className="input-icon">
                  <span className="ico"><Icon name="search" /></span>
                  <input
                    className="input"
                    type="search"
                    placeholder="Search apps…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Search apps"
                  />
                </div>
                {hasSystem && (
                  <label className="switch">
                    <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
                    <span className="track" />
                    System apps
                  </label>
                )}
              </div>
              <div className="data-toolbar-right">
                {apps && <span className="muted count-label">{visible.length} of {apps.length}</span>}
                <button type="button" className="btn btn--icon btn--ghost" onClick={() => refetch()} aria-label="Refresh" title="Refresh" disabled={isFetching}>
                  <Icon name="refresh" className={isFetching ? 'spin' : undefined} />
                </button>
              </div>
            </div>

            {error ? (
              <ErrorAlert
                error={error}
                title="Couldn’t get the installed apps"
                action={<button type="button" className="btn btn--sm btn--ghost" onClick={() => refetch()}>Retry</button>}
              />
            ) : isLoading ? (
              <div className="empty-state"><span className="spinner" /><p>Asking {active?.name} for its apps…</p></div>
            ) : visible.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"><Icon name="apps" /></div>
                <h3>{query ? 'No matching apps' : 'No apps installed yet'}</h3>
                <p>{query ? 'Try another search.' : 'Install an IPK from your computer, or browse the Homebrew repository.'}</p>
              </div>
            ) : (
              <div className="table-scroll">
                <table className="data-table apps-table">
                  <thead>
                    <tr>
                      <th>App</th>
                      <th className="hide-sm">Version</th>
                      <th className="hide-sm">Type</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((app) => (
                      <AppRow key={app.id} app={app} device={active} onLaunch={launch} onRemove={remove} busy={busy} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {active && (
              <div className="data-foot">
                <StorageBar device={active} />
              </div>
            )}
          </section>
        </NeedsDevice>
      </div>
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <Icon name="upload" />
            <div>Drop to install on {active?.name}</div>
          </div>
        </div>
      )}
      {dialog}
    </div>
  );
}

function AppRow({
  app,
  device,
  onLaunch,
  onRemove,
  busy,
}: {
  app: AppInfo;
  device: SavedDevice | null;
  onLaunch: (a: AppInfo) => void;
  onRemove: (a: AppInfo) => void;
  busy: boolean;
}) {
  const { toast } = useFeedback();
  const removable = app.removable !== false && !app.systemApp;
  const title = app.title ?? app.id;
  return (
    <tr>
      <td>
        <div className="data-cell-user">
          <AppIcon device={device} app={app} />
          <div className="data-cell-user-meta">
            <div className="data-cell-user-name">{title}</div>
            <div className="data-cell-user-email">
              {app.id}
              {app.version && <span className="show-sm app-version-sm">v{app.version}</span>}
            </div>
          </div>
        </div>
      </td>
      <td className="data-cell-mono hide-sm">{app.version ? `v${app.version}` : '—'}</td>
      <td className="hide-sm">{app.type ? <span className="badge">{app.type}</span> : '—'}</td>
      <td>
        <div className="row-actions">
          <button type="button" className="btn btn--sm btn--soft-primary" onClick={() => onLaunch(app)} aria-label={`Launch ${title}`}>
            <Icon name="play" /> <span className="hide-sm">Launch</span>
          </button>
          <Dropdown
            label={`More actions for ${title}`}
            menuClassName="dd-menu--compact"
            trigger={({ toggle, ...aria }) => (
              <button type="button" className="btn btn--icon btn--sm btn--ghost" aria-label={`More actions for ${title}`} onClick={toggle} {...aria}>
                <Icon name="more" />
              </button>
            )}
          >
            {(close) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="dd-menu-item"
                  onClick={() => {
                    close();
                    navigator.clipboard.writeText(app.id).then(() => toast({ kind: 'success', title: 'App id copied', text: app.id }));
                  }}
                >
                  <Icon name="copy" /> Copy app id
                </button>
                <div className="dd-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="dd-menu-item danger"
                  disabled={!removable || busy}
                  title={removable ? undefined : 'System apps can’t be uninstalled here'}
                  onClick={() => {
                    close();
                    onRemove(app);
                  }}
                >
                  <Icon name="trash" /> Uninstall
                </button>
              </>
            )}
          </Dropdown>
        </div>
      </td>
    </tr>
  );
}
