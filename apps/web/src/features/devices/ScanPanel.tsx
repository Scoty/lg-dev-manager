import { useEffect, useRef, useState } from 'react';
import type { ScanResult } from '@lgdm/protocol';
import { useRpc } from '../../bridge/useRpc';
import { describeError } from '../../components/ErrorAlert';
import { Icon } from '../../shell/icons';

/** "[LG] webOS TV OLED55C2" → "OLED55C2"-ish names users would recognise. */
export function tvLabel(tv: ScanResult): string {
  const n = tv.name?.replace(/^\[LG\]\s*/i, '').replace(/^webOS TV\s*/i, '').trim();
  return n || tv.modelName || 'LG TV';
}

/**
 * Finds LG TVs on the network (device.scan) and lets the user pick one. Runs once on mount, then on demand.
 */
export function ScanPanel({ selected, onPick }: { selected: string; onPick: (tv: ScanResult) => void }) {
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
          {tvs.map((tv) => (
            <button
              key={tv.host}
              type="button"
              role="option"
              aria-selected={selected === tv.host}
              className={`scan-item${selected === tv.host ? ' is-selected' : ''}`}
              onClick={() => onPick(tv)}
            >
              <span className="device-av"><Icon name="tv" /></span>
              <span className="scan-item-text">
                <span className="scan-item-name">{tvLabel(tv)}</span>
                <span className="scan-item-sub mono">{tv.host}{tv.modelName && tvLabel(tv) !== tv.modelName ? ` · ${tv.modelName}` : ''}</span>
              </span>
              <span className="scan-badges">
                <span className={`badge ${tv.ports.ssh22 ? 'success' : ''}`}>{tv.ports.ssh22 ? 'Root SSH on' : 'Root SSH off'}</span>
                {tv.ports.ssh9922 && <span className="badge info">Dev Mode</span>}
                {tv.ports.keyServer && <span className="badge info">Key server</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
