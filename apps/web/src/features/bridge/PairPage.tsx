import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Alert } from '../../components/Alert';
import { useFeedback } from '../../components/Feedback';
import { useBridge } from '../../bridge/BridgeProvider';
import { BridgeClient, BridgeError } from '../../bridge/client';
import { bridgeUrlProblem, defaultBridgeUrl, servedByLanBridge } from '../../bridge/settings';

/** What a pairing link carries: `#/pair?token=…[&port=…]`. */
export function readPairLink(search: string): { token: string; port?: number } | null {
  const q = new URLSearchParams(search);
  const token = q.get('token')?.trim();
  if (!token || token.length > 512) return null;
  const portText = q.get('port');
  const port = portText && /^\d{1,5}$/.test(portText) ? Number(portText) : undefined;
  return { token, port: port && port > 0 && port < 65536 ? port : undefined };
}

/** A new link opened in the same tab is a new pairing attempt. */
export function PairRoute() {
  const { search } = useLocation();
  return <PairPage key={search} />;
}

/**
 * `#/pair?token=…`: the pairing link the bridge prints (and the app opens). The token is taken out of the address
 * straight away. On a click — never by itself — it is checked with this page's own bridge (never an address from the
 * link; a link may only name another port on this computer, and then the page says it replaces the current bridge)
 * and saved only when the bridge accepts it.
 */
export function PairPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { pair, settings, status } = useBridge();
  const { toast } = useFeedback();
  // Read once: the address is cleared below, and the link mustn't be acted on twice.
  const link = useRef(readPairLink(location.search));
  const url = link.current ? defaultBridgeUrl(window.location, link.current.port) : null;
  const [error, setError] = useState<string | null>(
    !link.current ? 'This pairing link has no token.' : url && bridgeUrlProblem(url) ? 'This page can’t pair with a bridge from a link.' : null,
  );
  const [busy, setBusy] = useState(false);
  const already = !!url && settings?.url === url && settings.token === link.current?.token;
  // Pairing with a different bridge than the one this browser uses now (a link naming another port, say).
  const replaces = !!settings && !already && settings.url !== url;

  useEffect(() => {
    // Out of the address bar (and this history entry) before anything else happens. Behind the router's back, so
    // this page stays as it is; the router's own idea of the address (with the token) is dropped on the next move.
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/pair`);
  }, []);

  // Only on a click: a link a website opens can't make this browser try tokens (and get rate-limited) on its own.
  const confirm = async () => {
    if (!link.current || !url || busy) return;
    if (already && status.state === 'connected') return navigate('/devices', { replace: true });
    setBusy(true);
    setError(null);
    const probe = new BridgeClient(url, link.current.token);
    try {
      await probe.connect();
      probe.close();
      await pair({ url, token: link.current.token });
      toast({ kind: 'success', title: 'Paired with the bridge', text: 'This browser remembers it.' });
      navigate('/devices', { replace: true });
    } catch (e) {
      probe.close();
      const err = e instanceof BridgeError ? e : new BridgeError('unknown', String(e));
      setError(
        err.code === 'unauthorized'
          ? 'The bridge didn’t accept this link’s token. Use the newest link from the bridge’s window or logs (a new token makes old links stop working).'
          : err.code === 'rate_limited'
            ? err.message
            : `${err.message} Is the bridge running?`,
      );
    } finally {
      setBusy(false);
    }
  };

  const where = url?.replace(/^wss?:\/\//, '').replace(/\/rpc$/, '');
  return (
    <>
      <PageHeader eyebrow="Setup" title="Pair this" accent="browser" sub="From the pairing link the bridge printed." />
      <div className="grid">
        <Card title={error && !busy ? 'Not paired' : 'Pair with the bridge?'} className="col-6">
          <div className="stack">
            {link.current && url && !bridgeUrlProblem(url) && (
              <>
                <p style={{ margin: 0 }}>
                  This browser will use the bridge at <span className="mono">{where}</span>
                  {servedByLanBridge() ? ' (the one that serves this page)' : ' on this computer'}. Pair only with a link you got
                  from your own bridge.
                </p>
                {replaces && (
                  <Alert kind="warning">
                    It replaces the bridge this browser uses now (<span className="mono">{settings!.url}</span>).
                  </Alert>
                )}
                <div className="row">
                  <button type="button" className="btn btn--primary" onClick={confirm} disabled={busy}>
                    {busy ? 'Pairing…' : 'Pair'}
                  </button>
                  <Link to="/" className="btn btn--ghost">
                    Cancel
                  </Link>
                </div>
              </>
            )}
            {error && <Alert kind="danger">{error}</Alert>}
            <p className="muted" style={{ margin: 0 }}>
              You can also paste the token on the <Link to="/bridge">Bridge</Link> page.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
