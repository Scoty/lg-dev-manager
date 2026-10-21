import { Link, useParams } from 'react-router-dom';
import { BridgeFeatures } from '@lgdm/protocol';
import { PageHeader } from '../../components/PageHeader';
import { Alert } from '../../components/Alert';
import { useBridgeFeature } from '../../bridge/BridgeProvider';
import { useCustomRepos, useCustomReposLoaded } from '../../repos/store';
import { useStoredOnBridge } from '../../storage/backend';
import { RepoPage } from '../repo/RepoPage';
import { RepoSourceProvider } from '../repo/source';

/** Apps → <custom repository>: the repository page for one repository the user added. */
export function CustomRepoPage() {
  const { id } = useParams();
  const repo = useCustomRepos().find((r) => r.id === id);
  const loaded = useCustomReposLoaded();
  const onBridge = useStoredOnBridge();
  const supported = useBridgeFeature(BridgeFeatures.CustomRepos);

  if (!repo && !loaded) {
    return (
      <>
        <PageHeader eyebrow="Apps · custom repository" title="Loading…" />
        <div className="empty-state">
          <span className="spinner" />
          <p>Loading your custom repositories from the bridge…</p>
        </div>
      </>
    );
  }
  if (!repo) {
    return (
      <>
        <PageHeader eyebrow="Apps · custom repository" title="Repository not found" />
        <div className="page-notice">
          <Alert kind="info">
            {onBridge
              ? 'This custom repository isn’t saved on the bridge — it may have been removed. '
              : 'This custom repository isn’t saved in this browser — it may have been removed. '}
            See <Link to="/repos">Custom repos</Link>.
          </Alert>
        </div>
      </>
    );
  }
  if (supported === false) {
    // An older bridge would ignore the repository and show the official one instead: don't ask it.
    return (
      <>
        <PageHeader eyebrow="Apps · custom repository" title={repo.name} />
        <div className="page-notice">
          <Alert kind="warning" title="Update the bridge">
            Custom repositories need bridge 1.0.5 or newer. <Link to="/bridge">How to update</Link>
          </Alert>
        </div>
      </>
    );
  }
  return (
    // `key`: switching between repositories starts the page fresh (search, filter, open details).
    <RepoSourceProvider key={repo.id} source={{ custom: repo }}>
      <RepoPage />
    </RepoSourceProvider>
  );
}
