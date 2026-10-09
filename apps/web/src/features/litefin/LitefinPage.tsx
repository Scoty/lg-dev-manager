import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LITEFIN_APP_ID, LITEFIN_RELEASE_COUNT, LITEFIN_RELEASES_PAGE, type LitefinRelease } from '@lgdm/protocol';
import { PageHeader } from '../../components/PageHeader';
import { NeedsDevice } from '../../components/NeedsDevice';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { Alert } from '../../components/Alert';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useRpc } from '../../bridge/useRpc';
import { useDevices } from '../../devices/useDevices';
import type { SavedDevice } from '../../devices/store';
import { useAppOperations } from '../apps/operations';
import { useInstalledApps } from '../apps/queries';
import { fmtBytes } from '../info/shots';
import { compareVersions, suggestedVariant, variantColumns, variantInfo } from './variants';

const KEY = ['litefin-releases'];

/**
 * Litefin repo (M8): every webOS build of the latest Litefin releases, installable straight onto the TV. The Homebrew
 * repository only carries one build per version.
 */
export function LitefinPage() {
  const { active } = useDevices();
  return (
    <>
      <PageHeader
        eyebrow="Apps"
        title="Litefin"
        accent="repo"
        sub={
          <>
            Every webOS build of the last {LITEFIN_RELEASE_COUNT} <b>Litefin</b> releases (a lightweight Jellyfin client), straight from{' '}
            <a href={LITEFIN_RELEASES_PAGE} target="_blank" rel="noopener noreferrer">
              its GitHub releases
            </a>
            . The Homebrew repository only has one build per version.
          </>
        }
      />
      <div className="grid">
        <NeedsDevice device={active}>{active && <Releases key={active.id} device={active} />}</NeedsDevice>
      </div>
    </>
  );
}

function Releases({ device }: { device: SavedDevice }) {
  const { ready, call } = useRpc();
  const { confirm, toast } = useFeedback();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => call('litefin.list', {}, 60_000),
    enabled: ready,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const apps = useInstalledApps(device);
  const ops = useAppOperations(device, apps.data);
  const [refreshing, setRefreshing] = useState(false);

  const releases = useMemo(() => list.data?.releases ?? [], [list.data]);
  const columns = useMemo(() => variantColumns(releases), [releases]);
  const installed = apps.data?.find((a) => a.id === LITEFIN_APP_ID);
  const suggested = suggestedVariant(device.info?.osVersion);
  const latest = releases[0];

  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(KEY, await call('litefin.list', { refresh: true }, 60_000));
      apps.refetch();
    } catch (e) {
      toast({ kind: 'danger', title: 'Couldn’t refresh the releases', text: describeError(e).message });
    } finally {
      setRefreshing(false);
    }
  };

  const install = async (release: LitefinRelease, variant: string) => {
    const label = `Litefin ${release.version} (${variantInfo(variant).label})`;
    if (!apps.data) {
      // Couldn't read the TV's apps: Litefin may be there, and this would replace it.
      const ok = await confirm({
        title: `Install ${label}?`,
        message: <p>The apps on {device.name} couldn’t be read, so it isn’t known whether Litefin is installed. If it is, this replaces it.</p>,
        confirmText: 'Install',
      });
      if (!ok) return;
    } else if (installed) {
      const older = installed.version && compareVersions(release.version, installed.version) < 0;
      const ok = await confirm({
        title: `Replace Litefin on ${device.name}?`,
        message: (
          <>
            <p>
              Litefin {installed.version ? <b>v{installed.version}</b> : null} is installed. Every Litefin build is the same app, so installing{' '}
              <b>{label}</b> replaces it.
            </p>
            {older && <p>This is an older version than the one installed.</p>}
          </>
        ),
        confirmText: 'Install',
      });
      if (!ok) return;
    }
    await ops.installLitefin(release.tag, variant, label);
  };

  return (
    <section className="card col-12">
      <div className="data-toolbar">
        <div className="data-toolbar-left litefin-status">
          <span className="device-av"><Icon name="tv" /></span>
          <span>
            {apps.isLoading ? (
              <span className="muted">Checking {device.name}…</span>
            ) : installed ? (
              <>
                Litefin <b className="mono">v{installed.version}</b> is installed on <b>{device.name}</b>
                {latest && installed.version && compareVersions(latest.version, installed.version) > 0 && (
                  <span className="badge warning litefin-badge">v{latest.version} available</span>
                )}
              </>
            ) : (
              <>
                Litefin isn’t installed on <b>{device.name}</b>
              </>
            )}
            {suggested && (
              <span className="muted litefin-suggest">
                {' '}
                · Suggested for this TV: <b>{variantInfo(suggested).label}</b>
              </span>
            )}
          </span>
        </div>
        <div className="data-toolbar-right">
          {list.data && <span className="muted count-label">{releases.length} releases</span>}
          <a className="btn btn--ghost btn--sm" href={LITEFIN_RELEASES_PAGE} target="_blank" rel="noopener noreferrer">
            <Icon name="github" /> GitHub
          </a>
          <button type="button" className="btn btn--icon btn--ghost" onClick={refresh} disabled={!ready || refreshing} aria-label="Refresh" title="Check GitHub again">
            {refreshing ? <span className="spinner sm" /> : <Icon name="refresh" />}
          </button>
        </div>
      </div>

      {list.data?.stale && (
        <Alert kind="warning" title="Showing the list from earlier">
          {list.data.stale}
        </Alert>
      )}
      {list.error ? (
        <ErrorAlert error={list.error} title="Couldn’t load Litefin’s releases" action={<button type="button" className="btn btn--sm btn--ghost" onClick={() => list.refetch()}>Retry</button>} />
      ) : !list.data ? (
        <div className="empty-state"><span className="spinner" /><p>Reading Litefin’s releases from GitHub…</p></div>
      ) : !releases.length ? (
        <div className="empty-state">
          <h3>No releases with webOS builds</h3>
          <p>GitHub lists no published Litefin release with a webOS IPK right now.</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table litefin-table">
            <thead>
              <tr>
                <th scope="col">Release</th>
                {columns.map((v) => {
                  const info = variantInfo(v);
                  return (
                    <th key={v} className={v === suggested ? 'is-suggested' : undefined} scope="col">
                      <span className="litefin-variant">{info.label}</span>
                      {(info.webos || info.target) && <span className="litefin-variant-sub">{info.webos || 'If Ultra Legacy won’t start'}</span>}
                      {v === suggested && <span className="badge success litefin-badge">Suggested</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {releases.map((r, i) => {
                const isInstalled = !!installed?.version && compareVersions(installed.version, r.version) === 0;
                return (
                  <tr key={r.tag}>
                    <th scope="row" className="litefin-release">
                      <span className="litefin-version mono">v{r.version}</span>
                      {i === 0 && <span className="badge info litefin-badge">Latest</span>}
                      {isInstalled && <span className="badge success litefin-badge">Installed</span>}
                      <span className="litefin-date muted">
                        {r.publishedAt ? new Date(r.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''} ·{' '}
                        <a href={`${LITEFIN_RELEASES_PAGE}/tag/${encodeURIComponent(r.tag)}`} target="_blank" rel="noopener noreferrer">
                          Notes
                        </a>
                      </span>
                    </th>
                    {columns.map((v) => {
                      const asset = r.assets.find((a) => a.variant === v);
                      const label = `Install Litefin ${r.version} ${variantInfo(v).label}`;
                      return (
                        <td key={v} className={v === suggested ? 'is-suggested' : undefined}>
                          {asset ? (
                            <div className="litefin-cell">
                              <button
                                type="button"
                                className={`btn btn--sm ${v === suggested && i === 0 ? 'btn--primary' : 'btn--ghost'}`}
                                onClick={() => install(r, v)}
                                disabled={!ready || ops.busy || apps.isLoading}
                                aria-label={label}
                                title={asset.name}
                              >
                                <Icon name="download" /> Install
                              </button>
                              <span className="muted litefin-size">{asset.size ? fmtBytes(asset.size) : ''}</span>
                            </div>
                          ) : (
                            <span className="muted">
                              <span aria-hidden="true">—</span>
                              <span className="sr-only">No {variantInfo(v).label} build</span>
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {list.data && releases.length > 0 && (
        <div className="litefin-help">
          <b>Which build?</b>
          <ul className="plain-list litefin-help-list">
            {columns.map((v) => {
              const info = variantInfo(v);
              return (
                <li key={v}>
                  <b>{info.label}</b>
                  {info.target || info.webos ? ` — ${[info.target, info.webos].filter(Boolean).join(', ')}` : ''}
                </li>
              );
            })}
          </ul>
          <p className="muted">
            If you are unsure, try <b>Normal</b> first. If the app feels sluggish or fails to load, move down to <b>Legacy</b>. All builds are the same app,
            so installing one replaces the other.
          </p>
        </div>
      )}
      {ops.dialog}
    </section>
  );
}
