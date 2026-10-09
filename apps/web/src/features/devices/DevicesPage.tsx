import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../shell/icons';
import { useDevices } from '../../devices/useDevices';
import { DataPrivacyCard } from './DataPrivacyCard';

export function DevicesPage() {
  const { devices } = useDevices();
  return (
    <>
      <PageHeader eyebrow="Setup" title="Devices" sub="The TVs this browser knows about." />
      <div className="grid">
        <section className="card col-12">
          <div className="empty-state">
            <div className="empty-icon"><Icon name="tv" /></div>
            <h3>{devices?.length ? `${devices.length} saved TV${devices.length === 1 ? '' : 's'}` : 'No TVs yet'}</h3>
            <p>
              The add-device wizard arrives in M3: Developer Mode (key fetched from the Dev Mode app's key server) or rooted,
              with a port check and a test login.
            </p>
          </div>
        </section>
        <DataPrivacyCard />
      </div>
    </>
  );
}
