import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { BridgeFeatures, RepoErrorCodes } from '@lgdm/protocol';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Alert } from '../../components/Alert';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useRpc } from '../../bridge/useRpc';
import { useBridgeFeature } from '../../bridge/BridgeProvider';
import { addCustomRepo, MAX_CUSTOM_REPOS, removeCustomRepo, useCustomRepos, type CustomRepo } from '../../repos/store';

/** What the user should do about a failed check, beyond the bridge's message. */
function checkHint(e: unknown) {
  const { code } = describeError(e);
  if (code === RepoErrorCodes.NotARepo) {
    return (
      <>
        A repository’s address is a <span className="mono">.json</span> file — often <span className="mono">apps.json</span>{' '}
        or <span className="mono">repo.json</span>, like{' '}
        <span className="mono">https://repo.webosbrew.org/api/non-free/apps.json</span>. Its author usually gives it as
        the address to add in Homebrew Channel.
      </>
    );
  }
  if (code === RepoErrorCodes.Unreachable) return 'Check the address and this computer’s internet connection.';
  return null;
}

/**
 * Setup → Custom repositories: webOS Homebrew repositories besides the official one (the same addresses Homebrew
 * Channel's "Add repository" takes). Each is checked by the bridge before it is added, then shows up under Apps.
 * Not in the original Dev Manager.
 */
export function CustomReposPage() {
  const repos = useCustomRepos();
  const { ready, call } = useRpc();
  const supported = useBridgeFeature(BridgeFeatures.CustomRepos);
  const { confirm, toast } = useFeedback();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showErrors, setShowErrors] = useState(false);

  const canCheck = ready && supported === true && !busy;
  const full = repos.length >= MAX_CUSTOM_REPOS;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    setError(null);
    if (!url.trim() || !understood || !canCheck || full) return;
    setBusy(true);
    try {
      const res = await call('repo.check', { url: url.trim() }, 90_000);
      const repo = addCustomRepo({ name: name.trim() || new URL(res.url).host, url: res.url, apps: res.apps });
      toast({
        kind: 'success',
        title: `${repo.name} added`,
        text: `${res.apps} app${res.apps === 1 ? '' : 's'}${res.sample.length ? `, like ${res.sample.join(', ')}` : ''}. It’s under Apps in the sidebar.`,
      });
      setName('');
      setUrl('');
      setUnderstood(false);
      setShowErrors(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: CustomRepo) => {
    const ok = await confirm({
      title: `Remove ${r.name}?`,
      message: (
        <>
          <b>{r.name}</b> disappears from Apps. Apps you installed from it stay on your TVs; you can add the repository
          again later.
        </>
      ),
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    removeCustomRepo(r.id);
    toast({ kind: 'success', title: `${r.name} removed` });
  };

  return (
    <>
      <PageHeader
        eyebrow="Setup"
        title="Custom"
        accent="repositories"
        sub={
          <>
            Add webOS Homebrew repositories besides the official one — the same addresses Homebrew Channel’s “Add
            repository” takes. They’re saved in this browser and appear under Apps.
          </>
        }
      />
      <div className="page-notice">
        <Alert kind="danger" title="Unofficial repositories can contain untested apps or malware">
          Nobody reviews them — not LG, not the webOS Homebrew team. An app from one can be broken, collect your data or be
          malicious, and on a rooted TV apps can run with full (root) access to the TV. Only add repositories from people
          you trust, and prefer apps whose source code is published.
        </Alert>
      </div>
      <div className="grid">
        <Card eyebrow="Add" title="Add a repository" className="col-5">
          <form className="stack" onSubmit={onSubmit} noValidate>
            {supported === false && (
              <Alert kind="warning" title="Update the bridge">
                Your bridge is too old for custom repositories (they need bridge 1.0.5 or newer).{' '}
                <Link to="/bridge">How to update</Link>
              </Alert>
            )}
            <div className="field">
              <label className="field-label" htmlFor="repo-url">Repository address</label>
              <input
                id="repo-url"
                className="input mono"
                type="url"
                inputMode="url"
                placeholder="https://example.com/api/apps.json"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-invalid={(showErrors && !url.trim()) || undefined}
                aria-describedby="repo-url-help"
                required
              />
              {showErrors && !url.trim() ? (
                <span className="field-error">Enter the repository’s address.</span>
              ) : (
                <span className="field-help" id="repo-url-help">
                  The address you’d add in Homebrew Channel — its <span className="mono">apps.json</span> or{' '}
                  <span className="mono">repo.json</span> (a GitHub link to that file works too). https only, on the public
                  internet.
                </span>
              )}
            </div>
            <div className="field">
              <label className="field-label" htmlFor="repo-name">Name <span className="muted">(optional)</span></label>
              <input id="repo-name" className="input" maxLength={60} placeholder="Shown in the sidebar" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label className="check">
                <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
                <span className="box" />
                <span>I understand that apps from this repository aren’t reviewed and may be unsafe.</span>
              </label>
              {showErrors && !understood && <span className="field-error">Tick this to add the repository.</span>}
            </div>
            {error !== null && <ErrorAlert error={error} title="Couldn’t add the repository" hint={checkHint(error)} />}
            {full && <Alert kind="info">You can add up to {MAX_CUSTOM_REPOS} repositories. Remove one to add another.</Alert>}
            <div>
              <button type="submit" className="btn btn--primary" disabled={!canCheck || full}>
                {busy ? <span className="spinner sm" /> : <Icon name="check" />} {busy ? 'Checking…' : 'Check & add'}
              </button>
            </div>
            {!ready && <span className="field-help">Connect the bridge to check a repository — it fetches it for this page.</span>}
          </form>
        </Card>

        <Card eyebrow="Saved in this browser" title="Your repositories" className="col-7">
          {repos.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><Icon name="box" /></div>
              <h3>No custom repositories</h3>
              <p>
                The official <Link to="/apps/homebrew">Homebrew repository</Link> is always there. Add others with the form.
              </p>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table custom-repos-table">
                <thead>
                  <tr>
                    <th>Repository</th>
                    <th className="hide-sm">Apps</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {repos.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link to={`/apps/repo/${r.id}`} className="custom-repo-name">{r.name}</Link>
                        <div className="mono muted custom-repo-url">{r.url}</div>
                      </td>
                      <td className="hide-sm">{r.apps ?? '—'}</td>
                      <td className="actions">
                        <Link to={`/apps/repo/${r.id}`} className="btn btn--sm btn--soft-primary" aria-label={`Open ${r.name}`}>
                          <Icon name="apps" /> <span className="hide-sm">Open</span>
                        </Link>
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(r)} aria-label={`Remove ${r.name}`}>
                          <Icon name="trash" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
