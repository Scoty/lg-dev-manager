import { useMemo, useState } from 'react';
import { TvName } from '../../components/TvName';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BridgeFeatures,
  LITEFIN_APP_ID,
  LITEFIN_DEV_BUILDS_PAGE,
  LITEFIN_RELEASE_COUNT,
  LITEFIN_RELEASES_PAGE,
  type LitefinChannel,
  type LitefinRelease,
} from '@lgdm/protocol';
import { PageHeader } from '../../components/PageHeader';
import { NeedsDevice } from '../../components/NeedsDevice';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { Alert } from '../../components/Alert';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useRpc } from '../../bridge/useRpc';
import { useDevices } from '../../devices/useDevices';
import { toTarget, type SavedDevice } from '../../devices/store';
import { useAppOperations } from '../apps/operations';
import { useInstalledApps } from '../apps/queries';
import { count, fmtBytes } from '../../lib/format';
import { useBridgeFeature } from '../../bridge/BridgeProvider';
import { compareVersions, suggestedVariant, variantColumns, variantInfo } from './variants';

const KEY = ['litefin-releases'];
/** The source of each dev build, in Litefin's own repository. */
const LITEFIN_COMMIT_PAGE = 'https://github.com/MoazSalem/litefin/commit/';

/**
 * Litefin repo (M8): every webOS build of the latest Litefin releases, installable straight onto the TV. The Homebrew
 * repository only carries one build per version. From 2.0.2 (bridge feature litefinDev) also Litefin's dev builds — one
 * per commit to its development branch, all with the same version, so they're told apart by build number and commit.
 */
export function LitefinPage() {
  const { active } = useDevices();
  const devSupported = useBridgeFeature(BridgeFeatures.LitefinDev);
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
            {devSupported && ' Dev builds has the newest builds of its development branch, made for every change.'}
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
  const devSupported = useBridgeFeature(BridgeFeatures.LitefinDev);
  const [picked, setChannel] = useState<LitefinChannel>('stable');
  // An older bridge would answer a dev builds request with its releases: only ask one that knows the difference.
  const channel: LitefinChannel = devSupported ? picked : 'stable';
  const dev = channel === 'dev';
  const key = [...KEY, channel];
  const params = dev ? { channel } : {};
  // Both lists, when the bridge has dev builds: the status line compares what's installed with either.
  const listOf = (c: LitefinChannel, enabled: boolean) => ({
    queryKey: [...KEY, c],
    queryFn: () => call('litefin.list', c === 'dev' ? { channel: c } : {}, 60_000),
    enabled: ready && enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const stableList = useQuery(listOf('stable', true));
  const devList = useQuery(listOf('dev', !!devSupported));
  const list = dev ? devList : stableList;
  const apps = useInstalledApps(device);
  const ops = useAppOperations(device, apps.data);
  const [refreshing, setRefreshing] = useState(false);

  const releases = useMemo(() => list.data?.releases ?? [], [list.data]);
  const columns = useMemo(() => variantColumns(releases), [releases]);
  const installed = apps.data?.find((a) => a.id === LITEFIN_APP_ID);
  const suggested = suggestedVariant(device.info?.osVersion);
  const page = dev ? LITEFIN_DEV_BUILDS_PAGE : LITEFIN_RELEASES_PAGE;

  // Which listed release or dev build is installed: the bridge compares the time the TV's files were packaged with
  // each listed package's (to the second), so a build made by hand matches none.
  const which = useQuery({
    queryKey: ['litefin-installed', device.id, installed?.version],
    queryFn: () => call('litefin.installed', { device: toTarget(device) }, 120_000),
    enabled: ready && !!devSupported && !!installed,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const match = which.data?.match;
  const builtAt = which.data?.builtAt;
  const matched = match && (match.channel === 'dev' ? devList : stableList).data?.releases.find((r) => r.tag === match.tag);
  const notListed = !!builtAt && !match;
  /** Is this release (or dev build) the one on the TV? By its files when the bridge could tell, else by version. */
  const isInstalledRow = (r: LitefinRelease) =>
    which.data?.builtAt !== undefined ? r.tag === match?.tag : !r.build && !!installed?.version && compareVersions(installed.version, r.version) === 0;

  // What's newer than the installed build: after a dev build, a release made after it (with at least its version), or a
  // later dev build; otherwise a release with a higher version.
  const latestRelease = stableList.data?.releases[0];
  const newer = useMemo((): { kind: 'release' | 'dev'; release: LitefinRelease } | null => {
    const version = installed?.version;
    if (!version) return null;
    if (match?.channel === 'dev' && builtAt) {
      const release = stableList.data?.releases.find((r) => Date.parse(r.publishedAt) > builtAt && compareVersions(r.version, version) >= 0);
      if (release) return { kind: 'release', release };
      const latestDev = devList.data?.releases[0];
      return latestDev?.build && matched?.build && latestDev.build.number > matched.build.number ? { kind: 'dev', release: latestDev } : null;
    }
    return latestRelease && compareVersions(latestRelease.version, version) > 0 ? { kind: 'release', release: latestRelease } : null;
  }, [installed?.version, match?.channel, builtAt, stableList.data, devList.data, matched, latestRelease]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(key, await call('litefin.list', { ...params, refresh: true }, 60_000));
      apps.refetch();
      qc.invalidateQueries({ queryKey: ['litefin-installed', device.id] });
    } catch (e) {
      toast({ kind: 'danger', title: 'Couldn’t refresh the releases', text: describeError(e).message });
    } finally {
      setRefreshing(false);
    }
  };

  const install = async (release: LitefinRelease, variant: string) => {
    const build = release.build;
    const label = build ? `Litefin dev build #${build.number} (${variantInfo(variant).label})` : `Litefin ${release.version} (${variantInfo(variant).label})`;
    const devNote = build && (
      <p>
        Dev builds aren’t tested releases: a new one is made for every change to Litefin’s development branch, so it gets fixes and features first but
        can be broken. To go back, install a release.
      </p>
    );
    if (!apps.data) {
      // Couldn't read the TV's apps: Litefin may be there, and this would replace it.
      const ok = await confirm({
        title: `Install ${label}?`,
        message: (
          <>
            <p>The apps on {device.name} couldn’t be read, so it isn’t known whether Litefin is installed. If it is, this replaces it.</p>
            {devNote}
          </>
        ),
        confirmText: 'Install',
      });
      if (!ok) return;
    } else if (installed) {
      const older = !build && installed.version && compareVersions(release.version, installed.version) < 0;
      const ok = await confirm({
        title: `Replace Litefin on ${device.name}?`,
        message: (
          <>
            <p>
              Litefin {installed.version ? <b>v{installed.version}</b> : null} is installed. Every Litefin build is the same app, so installing{' '}
              <b>{label}</b> replaces it.
            </p>
            {older && <p>This is an older version than the one installed.</p>}
            {devNote}
          </>
        ),
        confirmText: 'Install',
      });
      if (!ok) return;
    } else if (build) {
      const ok = await confirm({ title: `Install ${label}?`, message: devNote, confirmText: 'Install' });
      if (!ok) return;
    }
    await ops.installLitefin(release.tag, variant, label, channel);
    qc.invalidateQueries({ queryKey: ['litefin-installed', device.id] });
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
                {matched?.build ? (
                  <>
                    Litefin <b className="mono">dev build #{matched.build.number}</b> (v{installed.version}) is installed on <TvName device={device} />
                  </>
                ) : (
                  <>
                    Litefin <b className="mono">v{installed.version}</b> is installed on <TvName device={device} />
                  </>
                )}
                {match?.variant && <span className="muted"> ({variantInfo(match.variant).label} build)</span>}
                {notListed && (
                  <span className="muted" title="Its files were packaged at a time no listed release or dev build matches — a build made by hand, or an older one.">
                    {' '}
                    · not a listed build (packaged {new Date(builtAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })})
                  </span>
                )}
                {newer &&
                  (newer.kind === 'dev' ? (
                    <span className="badge warning litefin-badge">Dev build #{newer.release.build?.number} available</span>
                  ) : (
                    <span className="badge warning litefin-badge">
                      {match?.channel === 'dev' ? `Release v${newer.release.version} available` : `v${newer.release.version} available`}
                    </span>
                  ))}
              </>
            ) : (
              <>
                Litefin isn’t installed on <TvName device={device} />
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
          {devSupported && (
            <div className="tabs pills" role="group" aria-label="Show">
              {(['stable', 'dev'] as const).map((c) => (
                <button key={c} type="button" className={`tab${channel === c ? ' is-active' : ''}`} aria-pressed={channel === c} onClick={() => setChannel(c)}>
                  {c === 'dev' ? 'Dev builds' : 'Releases'}
                </button>
              ))}
            </div>
          )}
          {list.data && <span className="muted count-label">{dev ? count(releases.length, 'dev build') : count(releases.length, 'release')}</span>}
          <a className="btn btn--ghost btn--sm" href={page} target="_blank" rel="noopener noreferrer">
            <Icon name="github" /> GitHub
          </a>
          <button type="button" className="btn btn--icon btn--ghost" onClick={refresh} disabled={!ready || refreshing} aria-label="Refresh" title="Check GitHub again">
            {refreshing ? <span className="spinner sm" /> : <Icon name="refresh" />}
          </button>
        </div>
      </div>

      {dev && (
        <div className="page-notice">
          <Alert kind="warning" title="Dev builds are untested">
            A new build is made for every change to Litefin’s development branch: fixes and features arrive here first, but a build can be broken. They
            all carry the version being worked on, so the build number and commit tell them apart. To go back, install a release.
          </Alert>
        </div>
      )}
      {list.data?.stale && (
        <Alert kind="warning" title="Showing the list from earlier">
          {list.data.stale}
        </Alert>
      )}
      {list.error ? (
        <ErrorAlert error={list.error} title={dev ? 'Couldn’t load Litefin’s dev builds' : 'Couldn’t load Litefin’s releases'} action={<button type="button" className="btn btn--sm btn--ghost" onClick={() => list.refetch()}>Retry</button>} />
      ) : !list.data ? (
        <div className="empty-state"><span className="spinner" /><p>{dev ? 'Reading Litefin’s dev builds from GitHub…' : 'Reading Litefin’s releases from GitHub…'}</p></div>
      ) : !releases.length ? (
        <div className="empty-state">
          <h3>{dev ? 'No dev builds with webOS files' : 'No releases with webOS builds'}</h3>
          <p>{dev ? 'GitHub lists no dev build with a webOS IPK right now. The newest may still be building.' : 'GitHub lists no published Litefin release with a webOS IPK right now.'}</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table litefin-table">
            <thead>
              <tr>
                <th scope="col">{dev ? 'Build' : 'Release'}</th>
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
                const isInstalled = isInstalledRow(r);
                const when = r.publishedAt
                  ? new Date(r.publishedAt).toLocaleString(undefined, r.build ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' })
                  : '';
                return (
                  <tr key={r.tag}>
                    <th scope="row" className="litefin-release">
                      {r.build ? (
                        <>
                          <span className="litefin-version mono">#{r.build.number}</span>
                          <span className="muted mono litefin-build-version"> v{r.version}</span>
                        </>
                      ) : (
                        <span className="litefin-version mono">v{r.version}</span>
                      )}
                      {i === 0 && <span className="badge info litefin-badge">Latest</span>}
                      {isInstalled && <span className="badge success litefin-badge">Installed</span>}
                      {r.build?.message && (
                        <span className="litefin-commit-message" title={r.build.message}>
                          {r.build.message}
                        </span>
                      )}
                      <span className="litefin-date muted">
                        {when} ·{' '}
                        {r.build && /^[0-9a-f]{7,40}$/.test(r.build.commit) && (
                          <>
                            <a className="mono" href={`${LITEFIN_COMMIT_PAGE}${r.build.commit}`} target="_blank" rel="noopener noreferrer" title="The commit it was built from">
                              {r.build.commit}
                            </a>{' '}
                            ·{' '}
                          </>
                        )}
                        <a href={`${page}/tag/${encodeURIComponent(r.tag)}`} target="_blank" rel="noopener noreferrer">
                          Notes
                        </a>
                      </span>
                    </th>
                    {columns.map((v) => {
                      const asset = r.assets.find((a) => a.variant === v);
                      const label = r.build ? `Install Litefin dev build ${r.build.number} ${variantInfo(v).label}` : `Install Litefin ${r.version} ${variantInfo(v).label}`;
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
                              {isInstalled && match?.variant === v && <span className="badge success litefin-badge litefin-cell-badge">On the TV</span>}
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
