import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Alert } from '../../components/Alert';
import { useFeedback } from '../../components/Feedback';
import { useBridge } from '../../bridge/BridgeProvider';
import { BridgeClient, BridgeError } from '../../bridge/client';
import { bridgeUrlProblem, defaultBridgeUrl } from '../../bridge/settings';

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
 * `#/pair?token=…`: the one-click pairing link the bridge prints (and the app opens). The token is taken out of the
 * address straight away, checked against the bridge — this page's own bridge, never an address from the link — and
 * saved only when the bridge accepts it, so a stray or planted link can't replace a working pairing.
 */
export function PairPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { pair, settings, status } = useBridge();
  const { toast } = useFeedback();
  // Read once: the address is cleared below, and the link mustn't be acted on twice.
  const link = useRef(readPairLink(location.search));
  const [error, setError] = useState<string | null>(link.current ? null : 'This pairing link has no token.');
  const started = useRef(false);

  useEffect(() => {
    // Out of the address bar (and this history entry) before anything else happens. Behind the router's back, so
    // this page stays as it is; the router's own idea of the address (with the token) is dropped on the next move.
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/pair`);
    if (started.current || !link.current) return;
    started.current = true;
    const { token, port } = link.current;
    const url = defaultBridgeUrl(window.location, port);
    if (bridgeUrlProblem(url)) {
      setError('This page can’t pair with a bridge from a link.');
      return;
    }
    if (settings?.url === url && settings.token === token && status.state === 'connected') {
      navigate('/devices', { replace: true });
      return;
    }
    const probe = new BridgeClient(url, token);
    probe
      .connect()
      .then(async () => {
        probe.close();
        await pair({ url, token });
        toast({ kind: 'success', title: 'Paired with the bridge', text: 'This browser remembers it.' });
        navigate('/devices', { replace: true });
      })
      .catch((e: unknown) => {
        probe.close();
        const err = e instanceof BridgeError ? e : new BridgeError('unknown', String(e));
        setError(
          err.code === 'unauthorized'
            ? 'The bridge didn’t accept this link’s token. Use the newest link from the bridge’s window or logs (a new token makes old links stop working).'
            : `${err.message} Is the bridge running?`,
        );
      });
    // Runs once for the link it was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageHeader eyebrow="Setup" title="Pair this" accent="browser" sub="From the pairing link the bridge printed." />
      <div className="grid">
        <Card title={error ? 'Not paired' : 'Pairing…'} className="col-6">
          {error ? (
            <div className="stack">
              <Alert kind="danger">{error}</Alert>
              <p className="muted" style={{ margin: 0 }}>
                You can also paste the token on the <Link to="/bridge">Bridge</Link> page.
              </p>
            </div>
          ) : (
            <Alert kind="info" title="Checking the link with the bridge…">This takes a moment.</Alert>
          )}
        </Card>
      </div>
    </>
  );
}
