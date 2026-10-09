import { useMemo } from 'react';
import type { AppInfo, RepoPackage } from '@lgdm/protocol';
import type { SavedDevice } from '../../devices/store';
import { useInstalledApps } from '../apps/queries';
import { incompatibility, stateOf, type IncompatibleReason, type RepoAppState } from './logic';
import { useHbChannel, useRepoIndex } from './queries';

export interface RepoAppView {
  pkg: RepoPackage;
  installed?: AppInfo;
  state: RepoAppState;
  incompatible: IncompatibleReason[] | null;
}

/**
 * The repository seen from one TV: which apps are installed, which have updates, which may not work.
 * Shared by the Homebrew page and the Installed page's update badges.
 */
export function useRepoApps(device: SavedDevice | null) {
  const repo = useRepoIndex();
  const installedQ = useInstalledApps(device);
  const hb = useHbChannel(device);

  const view = useMemo(() => {
    const installed = new Map((installedQ.data ?? []).map((a) => [a.id, a]));
    const tv = device?.info ? { osVersion: device.info.osVersion, socName: device.info.socName } : undefined;
    const byId = new Map<string, RepoAppView>();
    for (const pkg of repo.data?.packages ?? []) {
      const app = installed.get(pkg.id);
      byId.set(pkg.id, {
        pkg,
        installed: app,
        // Before the installed list arrives nothing counts as installed; the buttons wait for it (see `ready`).
        state: stateOf(pkg, app ? (app.version ?? '') : undefined),
        incompatible: incompatibility(pkg, tv, hb.data),
      });
    }
    return byId;
  }, [repo.data, installedQ.data, hb.data, device?.info]);

  return {
    repo,
    installed: installedQ,
    hb,
    view,
    /** True once both the repository and the TV's apps are known. */
    ready: !!repo.data && !!installedQ.data,
  };
}
