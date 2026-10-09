import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useBridge } from '../bridge/BridgeProvider';
import { useDevices } from '../devices/useDevices';
import type { SavedDevice } from '../devices/store';
import { Icon } from '../shell/icons';

/** Gate for pages that work on a TV: needs a connected bridge and an active device. */
export function NeedsDevice({ device, children }: { device: SavedDevice | null; children: ReactNode }) {
  const { status } = useBridge();
  const { devices } = useDevices();

  if (status.state === 'unpaired' || status.state === 'error') {
    const unpaired = status.state === 'unpaired';
    return (
      <section className="card col-12">
        <div className="empty-state">
          <div className="empty-icon"><Icon name="plug" /></div>
          <h3>{unpaired ? 'Set up the bridge first' : 'The bridge isn’t connected'}</h3>
          <p>
            {unpaired
              ? 'The bridge is the small helper on this computer that talks to your TV. Start it in a terminal and pair this browser.'
              : `${status.message} Make sure the bridge is still running in its terminal.`}
          </p>
          <Link to="/bridge" className="btn btn--primary"><Icon name="plug" /> Bridge setup</Link>
        </div>
      </section>
    );
  }
  if (!device) {
    const has = !!devices?.length;
    return (
      <section className="card col-12">
        <div className="empty-state">
          <div className="empty-icon"><Icon name="tv" /></div>
          <h3>{has ? 'Choose a TV' : 'Add your TV'}</h3>
          <p>{has ? 'Pick the TV to work with from the switcher at the bottom of the sidebar.' : 'Add an LG TV in Developer Mode or a rooted TV to get started.'}</p>
          <Link to={has ? '/devices' : '/devices/new'} className="btn btn--primary">
            <Icon name={has ? 'tv' : 'plus'} /> {has ? 'Devices' : 'Add a TV'}
          </Link>
        </div>
      </section>
    );
  }
  return <>{children}</>;
}
