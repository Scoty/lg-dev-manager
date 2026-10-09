import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppInfo } from '@lgdm/protocol';
import { useRpc } from '../../bridge/useRpc';
import { toTarget, type SavedDevice } from '../../devices/store';

/** Query keys include `updatedAt` so editing a TV's address or login refetches everything. */
export const appsKey = (d: SavedDevice) => ['apps', d.id, d.updatedAt] as const;
export const storageKey = (d: SavedDevice) => ['storage', d.id, d.updatedAt] as const;

export function useInstalledApps(device: SavedDevice | null) {
  const { ready, call } = useRpc();
  return useQuery({
    queryKey: device ? appsKey(device) : ['apps', 'none'],
    queryFn: async () => (await call('apps.list', { device: toTarget(device!) }, 60_000)).apps,
    enabled: ready && !!device,
    staleTime: 30_000,
    retry: false,
  });
}

export function useStorage(device: SavedDevice | null) {
  const { ready, call } = useRpc();
  return useQuery({
    queryKey: device ? storageKey(device) : ['storage', 'none'],
    queryFn: () => call('device.storage', { device: toTarget(device!) }, 30_000),
    enabled: ready && !!device,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Where an app's icon lives on the TV. `icon` is usually relative to `folderPath` (app-manager.service.ts joins
 * them), but some firmware reports an absolute path.
 */
export function iconPath(app: AppInfo): string | null {
  if (!app.icon) return null;
  if (app.icon.startsWith('/')) return app.icon;
  if (!app.folderPath) return null;
  return `${app.folderPath.replace(/\/$/, '')}/${app.icon}`;
}

/** Icon as a data: URL. Fetched lazily per app and kept for the session. */
export function useAppIcon(device: SavedDevice | null, app: AppInfo) {
  const { ready, call } = useRpc();
  const path = iconPath(app);
  return useQuery({
    queryKey: ['icon', device?.id, device?.updatedAt, path],
    queryFn: async () => {
      const r = await call('apps.icon', { device: toTarget(device!), path: path! }, 30_000);
      return `data:${r.mime};base64,${r.base64}`;
    },
    enabled: ready && !!device && !!path && /\.(png|jpe?g|gif|webp|bmp)$/i.test(path),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
}

/** Refresh the app list and storage after an install or uninstall. */
export function useRefreshDeviceData() {
  const qc = useQueryClient();
  return (device: SavedDevice) => {
    qc.invalidateQueries({ queryKey: ['apps', device.id] });
    qc.invalidateQueries({ queryKey: ['storage', device.id] });
    // Installing or removing Homebrew Channel changes what the repository page flags as needing root.
    qc.invalidateQueries({ queryKey: ['hbchannel', device.id] });
  };
}
