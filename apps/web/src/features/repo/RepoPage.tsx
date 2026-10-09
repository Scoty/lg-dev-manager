import { useMemo, useState } from 'react';
import { TvName } from '../../components/TvName';
import { PageHeader } from '../../components/PageHeader';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { NeedsDevice } from '../../components/NeedsDevice';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useDevices } from '../../devices/useDevices';
import { useAppOperations } from '../apps/operations';
import { useRefreshRepo } from './queries';
import { RepoDetails } from './RepoDetails';
import { RepoIcon } from './RepoIcon';
import { useRepoApps, type RepoAppView } from './useRepoApps';

type Filter = 'all' | 'installed' | 'updates';

/**
 * The webOS Homebrew repository (ChannelComponent in the original): every app with search and filters,
 * install / update / launch, and a details dialog.
 */
export function RepoPage() {
  const { active } = useDevices();
  const { repo, installed, view, ready } = useRepoApps(active);
  const ops = useAppOperations(active, installed.data);
  const refreshRepo = useRefreshRepo();
  const { toast } = useFeedback();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const all = useMemo(() => [...view.values()].sort((a, b) => a.pkg.title.localeCompare(b.pkg.title)), [view]);
  const counts = useMemo(
    () => ({
      all: all.length,
      installed: all.filter((v) => v.installed).length,
      updates: all.filter((v) => v.state === 'update').length,
    }),
    [all],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((v) => (filter === 'installed' ? !!v.installed : filter === 'updates' ? v.state === 'update' : true))
      .filter(
        (v) =>
          !q ||
          v.pkg.title.toLowerCase().includes(q) ||
          v.pkg.id.toLowerCase().includes(q) ||
          (v.pkg.shortDescription ?? v.pkg.manifest?.appDescription ?? '').toLowerCase().includes(q),
      );
  }, [all, filter, query]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshRepo();
      installed.refetch();
    } catch (e) {
      toast({ kind: 'danger', title: 'Couldn’t refresh the repository', text: describeError(e).message });
    } finally {
      setRefreshing(false);
    }
  };

  const open = openId ? (view.get(openId) ?? null) : null;
  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'installed', label: 'Installed' },
    { id: 'updates', label: 'Updates' },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Apps"
        title="Homebrew"
        accent="repository"
        sub={
          <>
            Apps from{' '}
            <a href="https://repo.webosbrew.org/" target="_blank" rel="noopener noreferrer">
              repo.webosbrew.org
            </a>
            {active && (
              <>
                {' '}
                for <TvName device={active} />
              </>
            )}
            . Homebrew apps aren’t reviewed by LG — install what you trust.
          </>
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
                    placeholder="Search the repository…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Search the repository"
                  />
                </div>
                <div className="tabs pills" role="group" aria-label="Show">
                  {filters.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`tab${filter === f.id ? ' is-active' : ''}`}
                      aria-pressed={filter === f.id}
                      onClick={() => setFilter(f.id)}
                    >
                      {f.label}
                      {ready && <span className={`tab-count${f.id === 'updates' && counts.updates ? ' is-hot' : ''}`}>{counts[f.id]}</span>}
                    </button>
                  ))}
                </div>
              </div>
              <div className="data-toolbar-right">
                {repo.data && <span className="muted count-label">{visible.length} of {all.length}</span>}
                <button
                  type="button"
                  className="btn btn--icon btn--ghost"
                  onClick={refresh}
                  aria-label="Refresh"
                  title="Fetch the repository again"
                  disabled={refreshing || repo.isFetching}
                >
                  <Icon name="refresh" className={refreshing || repo.isFetching ? 'spin' : undefined} />
                </button>
              </div>
            </div>

            {repo.error ? (
              <ErrorAlert
                error={repo.error}
                title="Couldn’t load the Homebrew repository"
                action={<button type="button" className="btn btn--sm btn--ghost" onClick={() => repo.refetch()}>Retry</button>}
              />
            ) : !repo.data ? (
              <div className="empty-state"><span className="spinner" /><p>Fetching the repository…</p></div>
            ) : visible.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"><Icon name="store" /></div>
                <h3>{query ? 'No matching apps' : filter === 'updates' ? 'Everything is up to date' : 'Nothing here yet'}</h3>
                <p>
                  {query
                    ? 'Try another search.'
                    : filter === 'updates'
                      ? 'None of the repository apps on this TV has a newer version.'
                      : 'No repository apps are installed on this TV.'}
                </p>
              </div>
            ) : (
              <>
                {installed.error && (
                  <ErrorAlert error={installed.error} title={`Couldn’t read the apps on ${active?.name}`} hint="Install and update buttons stay off until it works." />
                )}
                <ul className="repo-grid">
                  {visible.map((v) => (
                    <RepoCard
                      key={v.pkg.id}
                      v={v}
                      ready={ready}
                      busy={ops.busy}
                      onOpen={() => setOpenId(v.pkg.id)}
                      onInstall={() => ops.installFromRepo(v.pkg, { update: v.state === 'update', incompatible: v.incompatible })}
                      onLaunch={() => ops.launch(v.installed ?? { id: v.pkg.id, title: v.pkg.title })}
                    />
                  ))}
                </ul>
              </>
            )}
          </section>
        </NeedsDevice>
      </div>
      <RepoDetails view={open} device={active} ready={ready} actions={ops} onClose={() => setOpenId(null)} />
      {ops.dialog}
    </>
  );
}

function RepoCard({
  v,
  ready,
  busy,
  onOpen,
  onInstall,
  onLaunch,
}: {
  v: RepoAppView;
  ready: boolean;
  busy: boolean;
  onOpen: () => void;
  onInstall: () => void;
  onLaunch: () => void;
}) {
  const { pkg, state, incompatible, installed } = v;
  const m = pkg.manifest;
  return (
    <li className={`repo-card${state === 'update' ? ' has-update' : ''}`}>
      <button type="button" className="repo-card-main" onClick={onOpen} aria-label={`Details for ${pkg.title}`}>
        <RepoIcon pkg={pkg} />
        <span className="repo-card-text">
          <span className="repo-card-title">{pkg.title}</span>
          <span className="repo-card-desc">{pkg.shortDescription ?? m?.appDescription ?? pkg.id}</span>
        </span>
      </button>
      <div className="repo-card-foot">
        <div className="repo-badges">
          {m && <span className="mono repo-card-version">v{m.version}</span>}
          {state === 'update' && <span className="badge warning" title={`Installed: v${installed?.version ?? '?'}`}>Update</span>}
          {state === 'installed' && <span className="badge success">Installed</span>}
          {m?.rootRequired === true && <span className="badge purple">Root</span>}
          {incompatible && (
            <span className="badge danger" title="Marked as not compatible with this TV">
              May not work
            </span>
          )}
        </div>
        {state === 'installed' ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={onLaunch} disabled={!ready || busy} aria-label={`Launch ${pkg.title}`}>
            <Icon name="play" /> Launch
          </button>
        ) : (
          <button
            type="button"
            className={`btn btn--sm ${state === 'update' ? 'btn--primary' : 'btn--soft-primary'}`}
            onClick={onInstall}
            disabled={!ready || busy || !m}
            aria-label={`${state === 'update' ? 'Update' : 'Install'} ${pkg.title}`}
          >
            <Icon name="download" /> {state === 'update' ? 'Update' : 'Install'}
          </button>
        )}
      </div>
    </li>
  );
}
