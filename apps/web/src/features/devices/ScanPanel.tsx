import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ScanResult } from '@lgdm/protocol';
import type { SavedDevice } from '../../devices/store';
import { useRpc } from '../../bridge/useRpc';
import { describeError } from '../../components/ErrorAlert';
import { Icon } from '../../shell/icons';

/** "[LG] webOS TV OLED55C2" → "OLED55C2"-ish names users would recognise. */
export function tvLabel(tv: ScanResult): string {
  const n = tv.name?.replace(/^\[LG\]\s*/i, '').replace(/^webOS TV\s*/i, '').trim();
  return n || tv.modelName || 'LG TV';
}

/** Same address, ignoring case and IPv6 brackets. */
export const sameHost = (a: string, b: string) => a.trim().replace(/^\[|\]$/g, '').toLowerCase() === b.trim().replace(/^\[|\]$/g, '').toLowerCase();

/** Saved TVs at this address. */
export const savedAt = (saved: readonly SavedDevice[], host: string) => saved.filter((d) => sameHost(d.host, host));

/**
 * Finds LG TVs on the network (device.scan) and lets the user pick one. Runs once on mount, then on demand.
 * TVs already saved in this browser are marked as added; they can still be picked, to add one with another login.
 */
export function ScanPanel({ selected, onPick, saved }: { selected: string; onPick: (tv: ScanResult) => void; saved: readonly SavedDevice[] }) {
  const { ready, call } = useRpc();
  const [tvs, setTvs] = useState<ScanResult[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      setTvs((await call('device.scan', { timeoutMs: 3000 }, 30_000)).tvs);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    if (ready && !started.current) {
      started.current = true;
      scan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <div className="scan-panel">
      <div className="scan-head">
        <div>
          <div className="scan-title">TVs on your network</div>
          <div className="field-help">
            {scanning
              ? 'Looking for LG TVs…'
              : tvs?.length
                ? 'Pick your TV, or type its address below.'
                : tvs
                  ? 'No LG TVs found. Make sure the TV is on and on the same network, or type its address below.'
                  : 'The bridge can look for LG TVs that are switched on.'}
          </div>
        </div>
        <button type="button" className="btn btn--sm btn--ghost" onClick={scan} disabled={!ready || scanning}>
          {scanning ? <span className="spinner sm" /> : <Icon name="search" />} {tvs ? 'Scan again' : 'Scan'}
        </button>
      </div>
      {error && <div className="field-error">{error}</div>}
      {!!tvs?.length && (
        <div className="scan-list" role="listbox" aria-label="TVs found on your network">
          {tvs.map((tv) => {
            const added = savedAt(saved, tv.host);
            const text = (
              <>
                <span className="device-av"><Icon name="tv" /></span>
                <span className="scan-item-text">
                  <span className="scan-item-name">{tvLabel(tv)}</span>
                  <span className="scan-item-sub mono">{tv.host}{tv.modelName && tvLabel(tv) !== tv.modelName ? ` · ${tv.modelName}` : ''}</span>
                  {added.length > 0 && (
                    <span className="scan-item-added">
                      Already added as <b>{added.map((d) => d.name).join(', ')}</b>
                    </span>
                  )}
                </span>
              </>
            );
            return (
              <button
                key={tv.host}
                type="button"
                role="option"
                aria-selected={selected === tv.host}
                className={`scan-item${selected === tv.host ? ' is-selected' : ''}${added.length ? ' is-added' : ''}`}
                onClick={() => onPick(tv)}
              >
                {text}
                <span className="scan-badges">
                  {added.length > 0 && <span className="badge success"><Icon name="check" /> Added</span>}
                  <span className={`badge ${tv.ports.ssh22 ? 'success' : ''}`}>{tv.ports.ssh22 ? 'Root SSH on' : 'Root SSH off'}</span>
                  {tv.ports.ssh9922 && <span className="badge info">Dev Mode</span>}
                  {tv.ports.keyServer && <span className="badge info">Key server</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {tvs?.some((tv) => savedAt(saved, tv.host).length) && (
        <div className="field-help">
          TVs marked “Added” are already in <Link to="/devices">Devices</Link>. You can still pick one to add it again with another
          login, e.g. as root after rooting it.
        </div>
      )}
    </div>
  );
}
