import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { RepoPackage } from '@lgdm/protocol';
import { useRpc } from '../../bridge/useRpc';
import { toTarget, type SavedDevice } from '../../devices/store';

/** The Homebrew repository's apps (fetched by the bridge, which also caches it for a few minutes). */
export function useRepo() {
  const { ready, call } = useRpc();
  return useQuery({
    queryKey: ['repo'],
    queryFn: () => call('repo.list', {}, 60_000),
    enabled: ready,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Ask the bridge to fetch the repository again (skipping its cache). */
export function useRefreshRepo() {
  const qc = useQueryClient();
  const { call } = useRpc();
  return async () => {
    qc.setQueryData(['repo'], await call('repo.list', { refresh: true }, 60_000));
  };
}

/** Repository entries by app id, for matching against installed apps. */
export function useRepoIndex() {
  const q = useRepo();
  const byId = useMemo(() => new Map<string, RepoPackage>((q.data?.packages ?? []).map((p) => [p.id, p])), [q.data]);
  return { ...q, byId };
}

/** An icon or screenshot from the repository, as a data: URL (through the bridge). */
export function useRepoImage(url: string | undefined) {
  const { ready, call } = useRpc();
  return useQuery({
    queryKey: ['repo-image', url],
    queryFn: async () => {
      const r = await call('repo.image', { url: url! }, 30_000);
      return `data:${r.mime};base64,${r.base64}`;
    },
    enabled: ready && !!url,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
}

export function useRepoDescription(pkg: RepoPackage | null) {
  const { ready, call } = useRpc();
  return useQuery({
    queryKey: ['repo-description', pkg?.id],
    queryFn: () => call('repo.description', { id: pkg!.id }, 30_000),
    enabled: ready && !!pkg?.hasDescription,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** Homebrew Channel on this TV: installed? rooted? (getHbChannelConfig). Read quietly. */
export function useHbChannel(device: SavedDevice | null) {
  const { ready, call } = useRpc();
  return useQuery({
    queryKey: ['hbchannel', device?.id, device?.updatedAt],
    queryFn: () => call('device.hbchannel', { device: toTarget(device!), quiet: true }, 30_000),
    enabled: ready && !!device,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
