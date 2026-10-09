import type { AppInfo } from '@lgdm/protocol';
import type { SavedDevice } from '../../devices/store';
import { useAppIcon } from './queries';

const TINTS = ['primary', 'success', 'purple', 'orange', 'pink', 'teal', 'info'] as const;

function tintFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

/** The app's own icon, read from the TV; initials on a tinted tile while loading or if there is none. */
export function AppIcon({ device, app }: { device: SavedDevice | null; app: AppInfo }) {
  const { data } = useAppIcon(device, app);
  const label = (app.title || app.id).trim();
  if (data) return <img className="app-icon" src={data} alt="" width={36} height={36} loading="lazy" />;
  return (
    <span className={`app-icon app-icon--fallback tint-${tintFor(app.id)}`} aria-hidden="true">
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}
