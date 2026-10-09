import { webosName } from '../../lib/webosVersion';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Alert } from '../../components/Alert';
import { useFeedback } from '../../components/Feedback';
import { describeError } from '../../components/ErrorAlert';
import { Dropdown } from '../../components/Dropdown';
import { Icon } from '../../shell/icons';
import { useRpc } from '../../bridge/useRpc';
import { removeDevice, setActiveDeviceId, setDeviceInfo, toTarget, tvInfo, type SavedDevice } from '../../devices/store';
import { modelLine } from '../../devices/model';
import { useDevices } from '../../devices/useDevices';
import { DataPrivacyCard } from './DataPrivacyCard';
import { EditDeviceDialog } from './EditDeviceDialog';
import { describeLogin } from './auth';

export function DevicesPage() {
  const { devices, activeId } = useDevices();
  const { ready, call } = useRpc();
  const { confirm, toast } = useFeedback();
  const [editing, setEditing] = useState<SavedDevice | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const test = async (d: SavedDevice) => {
    setTesting(d.id);
    try {
      const device = toTarget(d);
      const login = await call('device.test', { device }, 40_000);
      const info = await call('device.info', { device }, 40_000).catch(() => null);
      if (info) setDeviceInfo(d.id, tvInfo(d, info)).catch(() => {});
      toast({
        kind: 'success',
        title: `${d.name} is reachable`,
        text: [modelLine(info?.modelName), info?.osVersion && `webOS ${webosName(info.osVersion)}`, `${login.latencyMs} ms`, login.root ? 'root' : null]
          .filter(Boolean)
          .join(' · '),
      });
    } catch (e) {
      toast({ kind: 'danger', title: `Couldn’t reach ${d.name}`, text: describeError(e).message });
    } finally {
      setTesting(null);
    }
  };

  const remove = async (d: SavedDevice) => {
    const ok = await confirm({
      title: `Remove ${d.name}?`,
      message: (
        <>
          This removes <b>{d.name}</b> and its saved {describeLogin(d.auth)} from this browser. Nothing on the TV changes, and you can
          add it again later.
        </>
      ),
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    if (ready) call('device.disconnect', { device: toTarget(d) }).catch(() => {});
    await removeDevice(d.id);
    toast({ kind: 'success', title: `Removed ${d.name}` });
  };

  return (
    <>
      <PageHeader
        eyebrow="Setup"
        title="Devices"
        sub="The TVs this browser knows about. The active TV is the one the Apps, Files and Terminal pages work with."
        actions={
          <Link to="/devices/new" className="btn btn--primary">
            <Icon name="plus" /> Add a TV
          </Link>
        }
      />
      <div className="grid">
        {!ready && (devices?.length ?? 0) > 0 && (
          <div className="col-12">
            <Alert kind="info" title="The bridge isn’t connected" action={<Link to="/bridge" className="btn btn--sm btn--ghost">Bridge</Link>}>
              You can rename or remove TVs, but testing them needs the bridge.
            </Alert>
          </div>
        )}
        <section className="card col-12">
          {devices === null ? (
            <div className="empty-state"><span className="spinner" /></div>
          ) : devices.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><Icon name="tv" /></div>
              <h3>No TVs yet</h3>
              <p>Add your LG TV in Developer Mode or a rooted TV. The wizard checks the connection and fetches the login key for you.</p>
              <Link to="/devices/new" className="btn btn--primary"><Icon name="plus" /> Add a TV</Link>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table devices-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="hide-sm">Address</th>
                    <th className="hide-sm">Type</th>
                    <th className="hide-sm">Login</th>
                    <th aria-label="Status" />
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => {
                    const active = d.id === activeId;
                    return (
                      <tr key={d.id} className={active ? 'is-selected' : undefined}>
                        <td>
                          <div className="data-cell-user">
                            <span className="device-av"><Icon name="tv" /></span>
                            <div className="data-cell-user-meta">
                              <div className="data-cell-user-name">{d.name}</div>
                              {d.info?.modelName && (
                                <div className="cell-sub" title={d.info.firmwareVersion ? `Firmware ${d.info.firmwareVersion}` : undefined}>
                                  {modelLine(d.info.modelName)}
                                  {d.info.osVersion && <> · webOS {webosName(d.info.osVersion)}</>}
                                </div>
                              )}
                              {d.description && <div className="cell-sub">{d.description}</div>}
                              <div className="cell-sub mono show-sm">{d.host}:{d.port}</div>
                            </div>
                          </div>
                        </td>
                        <td className="data-cell-mono hide-sm">{d.host}:{d.port}</td>
                        <td className="hide-sm">
                          <span className={`badge ${d.mode === 'rooted' ? 'purple' : 'info'}`}>{d.mode === 'rooted' ? 'Rooted' : 'Dev Mode'}</span>
                        </td>
                        <td className="data-cell-mono hide-sm">{d.username} · {describeLogin(d.auth)}</td>
                        <td>
                          {active ? (
                            <span className="badge success dot">Active</span>
                          ) : (
                            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setActiveDeviceId(d.id)}>
                              Make active
                            </button>
                          )}
                        </td>
                        <td>
                          <div className="data-cell-actions">
                            <button
                              type="button"
                              className="btn btn--icon"
                              title="Test connection"
                              aria-label={`Test connection to ${d.name}`}
                              onClick={() => test(d)}
                              disabled={!ready || testing === d.id}
                            >
                              {testing === d.id ? <span className="spinner sm" /> : <Icon name="pulse" />}
                            </button>
                            <button type="button" className="btn btn--icon" title="Edit" aria-label={`Edit ${d.name}`} onClick={() => setEditing(d)}>
                              <Icon name="edit" />
                            </button>
                            <Dropdown
                              label={`More actions for ${d.name}`}
                              menuClassName="dd-menu--compact"
                              floating
                              trigger={({ toggle, ...aria }) => (
                                <button type="button" className="btn btn--icon" aria-label={`More actions for ${d.name}`} onClick={toggle} {...aria}>
                                  <Icon name="more" />
                                </button>
                              )}
                            >
                              {(close) => (
                                <>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="dd-menu-item danger"
                                    onClick={() => {
                                      close();
                                      remove(d);
                                    }}
                                  >
                                    <Icon name="trash" /> Remove from this browser
                                  </button>
                                </>
                              )}
                            </Dropdown>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <DataPrivacyCard />
      </div>
      <EditDeviceDialog device={editing} onClose={() => setEditing(null)} />
    </>
  );
}
