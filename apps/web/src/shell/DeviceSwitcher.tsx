import { useNavigate } from 'react-router-dom';
import { Dropdown } from '../components/Dropdown';
import { setActiveDeviceId } from '../devices/store';
import { useDevices } from '../devices/useDevices';
import { modelLabel } from '../devices/model';
import { Icon } from './icons';

/** Sidebar-footer device chooser (home/device-chooser in the original), on Adminator's `.workspace` button. */
export function DeviceSwitcher() {
  const navigate = useNavigate();
  const { devices, active } = useDevices();
  return (
    <Dropdown
      label="Choose TV"
      placement="up-left"
      className="device-switcher"
      menuClassName="dd-menu--compact"
      trigger={({ toggle, ...aria }) => (
        <button
          type="button"
          className="workspace"
          title="Choose TV"
          aria-label={active ? `Active TV: ${active.name}. Choose TV` : 'Choose TV'}
          onClick={toggle}
          {...aria}
        >
          <div className="workspace-avatar">
            <Icon name="tv" />
          </div>
          <div className="workspace-text">
            <div className="workspace-name">{active?.name ?? 'No TV selected'}</div>
            <div className="workspace-role">
              {active
                ? `${modelLabel(active.info?.modelName) ?? active.host} · ${active.mode === 'rooted' ? 'rooted' : 'Dev Mode'}`
                : devices?.length
                  ? 'choose a TV'
                  : 'add a TV to start'}
            </div>
          </div>
          <Icon name="updown" className="workspace-chev" strokeWidth={1.8} />
        </button>
      )}
    >
      {(close) => (
        <>
          {!!devices?.length && <div className="dd-section-label">Your TVs</div>}
          {devices?.map((d) => (
            <button
              key={d.id}
              type="button"
              role="menuitemradio"
              aria-checked={d.id === active?.id}
              className={`dd-menu-item${d.id === active?.id ? ' is-active' : ''}`}
              onClick={() => {
                setActiveDeviceId(d.id);
                close();
              }}
            >
              <Icon name="tv" />
              <span className="dd-menu-text">
                <span>{d.name}</span>
                <span className="dd-menu-sub mono">{[modelLabel(d.info?.modelName), d.host].filter(Boolean).join(' · ')}</span>
              </span>
              {d.id === active?.id && <Icon name="check" className="dd-check" strokeWidth={2.4} />}
            </button>
          ))}
          {!!devices?.length && <div className="dd-divider" />}
          <button type="button" role="menuitem" className="dd-menu-item" onClick={() => (close(), navigate('/devices/new'))}>
            <Icon name="plus" /> Add a TV
          </button>
          <button type="button" role="menuitem" className="dd-menu-item" onClick={() => (close(), navigate('/devices'))}>
            <Icon name="wrench" /> Manage devices
          </button>
        </>
      )}
    </Dropdown>
  );
}
