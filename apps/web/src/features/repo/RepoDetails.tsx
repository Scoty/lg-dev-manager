import type { AppInfo, RepoPackage } from '@lgdm/protocol';
import { Modal } from '../../components/Modal';
import { Alert } from '../../components/Alert';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Icon } from '../../shell/icons';
import type { SavedDevice } from '../../devices/store';
import { fmtSize, INCOMPATIBLE_TEXT, type IncompatibleReason } from './logic';
import { useRepoDescription, useRepoImage } from './queries';
import { RepoIcon, RepoScreenshot } from './RepoIcon';
import { SafeHtml } from './SafeHtml';
import type { RepoAppView } from './useRepoApps';

export interface RepoActions {
  installFromRepo: (pkg: RepoPackage, o?: { channel?: 'stable' | 'beta'; update?: boolean; incompatible?: IncompatibleReason[] | null }) => Promise<boolean>;
  remove: (app: AppInfo) => void;
  launch: (app: AppInfo) => void;
  busy: boolean;
}

/** One repository app: description, screenshots, install / update / launch (DetailsComponent in the original). */
export function RepoDetails({
  view,
  device,
  ready,
  actions,
  onClose,
}: {
  view: RepoAppView | null;
  device: SavedDevice | null;
  ready: boolean;
  actions: RepoActions;
  onClose: () => void;
}) {
  const pkg = view?.pkg ?? null;
  const desc = useRepoDescription(pkg);
  if (!view || !pkg) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;
  const { installed, state, incompatible } = view;
  const m = pkg.manifest;
  const disabled = !device || !ready || actions.busy;

  return (
    <Modal open onClose={onClose} size="lg" title={pkg.title}>
      <div className="repo-details">
        <div className="repo-details-head">
          <RepoIcon pkg={pkg} size={88} detail />
          <div className="repo-details-meta">
            <div className="mono muted repo-details-id">{pkg.id}</div>
            <div className="repo-details-version">
              {m ? <>Version <b>{m.version}</b></> : 'No release'}
              {m?.ipkSize ? <span className="muted"> · {fmtSize(m.ipkSize)}</span> : null}
              {installed && (
                <span className="muted">
                  {' '}
                  · installed {installed.version ? `v${installed.version}` : ''}
                </span>
              )}
            </div>
            <div className="repo-badges">
              {state === 'update' && <span className="badge warning">Update available</span>}
              {state === 'installed' && <span className="badge success">Installed</span>}
              {m?.rootRequired === true && <span className="badge purple">Root required</span>}
              {m?.rootRequired === 'optional' && <span className="badge purple">Root optional</span>}
              {pkg.manifestBeta && <span className="badge info">Beta {pkg.manifestBeta.version}</span>}
            </div>
          </div>
          <div className="repo-details-actions">
            {state === 'installed' ? (
              <button type="button" className="btn btn--primary" disabled={disabled} onClick={() => actions.launch(installed ?? { id: pkg.id, title: pkg.title })}>
                <Icon name="play" /> Launch
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={disabled || !m}
                onClick={() => actions.installFromRepo(pkg, { update: state === 'update', incompatible })}
              >
                <Icon name="download" /> {state === 'update' ? `Update to ${m?.version}` : 'Install'}
              </button>
            )}
          </div>
        </div>

        {incompatible && (
          <Alert kind="warning" title={`${pkg.title} is marked as not compatible with ${device?.name ?? 'this TV'}`}>
            <ul className="plain-list">
              {incompatible.map((r) => (
                <li key={r}>{INCOMPATIBLE_TEXT[r]}</li>
              ))}
            </ul>
          </Alert>
        )}

        <div className="repo-details-secondary">
          {pkg.manifestBeta && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={disabled}
              onClick={() => actions.installFromRepo(pkg, { channel: 'beta', incompatible: incompatible })}
            >
              <Icon name="download" /> Install beta {pkg.manifestBeta.version}
            </button>
          )}
          {m?.sourceUrl && (
            <a className="btn btn--sm btn--ghost" href={m.sourceUrl} target="_blank" rel="noopener noreferrer">
              <Icon name="external" /> Project page
            </a>
          )}
          {state === 'update' && (
            <button type="button" className="btn btn--sm btn--ghost" disabled={disabled} onClick={() => actions.launch(installed ?? { id: pkg.id, title: pkg.title })}>
              <Icon name="play" /> Launch installed version
            </button>
          )}
          {installed && (
            <button type="button" className="btn btn--sm btn--soft-danger" disabled={disabled || installed.removable === false} onClick={() => actions.remove(installed)}>
              <Icon name="trash" /> Uninstall
            </button>
          )}
        </div>

        {!!pkg.screenshots?.length && (
          <div className="repo-shots" aria-label="Screenshots">
            {pkg.screenshots.map((s) => (
              <RepoScreenshot key={s.url} url={s.url} caption={s.caption} />
            ))}
          </div>
        )}

        <div className="repo-desc">
          {desc.isLoading ? (
            <div className="muted"><span className="spinner sm" /> Loading the description…</div>
          ) : desc.error ? (
            <ErrorAlert error={desc.error} title="Couldn’t load the description" />
          ) : desc.data?.html ? (
            <SafeHtml
              html={desc.data.html}
              baseUrl={desc.data.baseUrl}
              className="repo-desc-body"
              renderImage={(src, alt, key) => <DescriptionImage key={key} src={src} alt={alt} />}
            />
          ) : (
            <p>{m?.appDescription ?? pkg.shortDescription ?? 'No description.'}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** An image inside a description, loaded through the bridge like icons and screenshots. */
function DescriptionImage({ src, alt }: { src: string; alt: string }) {
  const { data } = useRepoImage(src);
  return data ? <img src={data} alt={alt} /> : null;
}
