import { Alert } from '../../components/Alert';
import type { SavedDevice } from '../../devices/store';

/** Shown on the apps pages while the active TV is in standby: what still works, and why Launch is disabled. */
export function TvOffNotice({ device, off }: { device: SavedDevice | null; off: boolean }) {
  if (!device || !off) return null;
  return (
    <div className="page-notice">
      <Alert kind="info" title={`${device.name} is off (standby)`}>
        Installing, updating and removing apps still works. To launch an app, turn the TV on with the remote — this page
        notices within a few seconds.
      </Alert>
    </div>
  );
}
