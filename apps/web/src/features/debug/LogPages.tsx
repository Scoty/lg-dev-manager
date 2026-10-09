import { Link } from 'react-router-dom';
import { TvName } from '../../components/TvName';
import { PageHeader } from '../../components/PageHeader';
import { NeedsDevice } from '../../components/NeedsDevice';
import { Alert } from '../../components/Alert';
import { Icon } from '../../shell/icons';
import { useDevices } from '../../devices/useDevices';
import type { SavedDevice } from '../../devices/store';
import { DMESG_COLUMNS, LogView, SYSLOG_COLUMNS } from './LogView';
import { parseDmesg, parseSyslog } from './parse';

/** Root-only debug tools: the original only shows these tabs for logins other than `prisoner` (debug.component.html). */
export function NeedsRoot({ device, what, children }: { device: SavedDevice; what: string; children: React.ReactNode }) {
  if (device.username === 'root') return <>{children}</>;
  return (
    <section className="card col-12">
      <Alert kind="info" title="Needs a rooted TV">
        {what} is only available when you are logged in as root (a rooted TV with Homebrew Channel). Developer Mode logins
        can still read <Link to="/debug/crashes">crash reports</Link>.
      </Alert>
    </section>
  );
}

const parseSys = (line: string, seq: number) => parseSyslog(line, seq);

/** System log (PmLogComponent): /var/log/messages, with developer logging switched on first. */
export function SyslogPage() {
  const { active } = useDevices();
  return (
    <>
      <PageHeader
        eyebrow="Debug"
        title="System"
        accent="log"
        sub={
          <>
            Live <span className="mono">/var/log/messages</span>
            {active ? <> from <TvName device={active} /></> : null}. Developer logging is switched on when it starts. Set what gets logged in{' '}
            <Link to="/debug/pmlog">Log levels</Link>.
          </>
        }
        actions={
          <Link to="/debug/pmlog" className="btn btn--ghost">
            <Icon name="cog" /> Log levels
          </Link>
        }
      />
      <div className="grid">
        <NeedsDevice device={active}>
          {active && (
            <NeedsRoot device={active} what="The system log">
              <LogView key={active.id} device={active} source="syslog" parse={parseSys} columns={SYSLOG_COLUMNS} history={100} clearLabel="Clear on TV" label="System log" />
            </NeedsRoot>
          )}
        </NeedsDevice>
      </div>
    </>
  );
}

/** Kernel log (DmesgComponent): `dmesg -w -x`. */
export function DmesgPage() {
  const { active } = useDevices();
  return (
    <>
      <PageHeader
        eyebrow="Debug"
        title="Kernel"
        accent="log"
        sub={<>The kernel ring buffer (<span className="mono">dmesg</span>){active ? <> of <TvName device={active} /></> : null}, followed live.</>}
      />
      <div className="grid">
        <NeedsDevice device={active}>
          {active && (
            <NeedsRoot device={active} what="The kernel log">
              <LogView key={active.id} device={active} source="dmesg" parse={parseDmesg} columns={DMESG_COLUMNS} clearLabel="Clear on TV" label="Kernel log" />
            </NeedsRoot>
          )}
        </NeedsDevice>
      </div>
    </>
  );
}
