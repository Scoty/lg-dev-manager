import { createContext, useContext, type ReactNode } from 'react';
import type { CustomRepo } from '../../repos/store';

/**
 * Which repository a repo page shows: the official webOS Homebrew repository (no `custom`), or one the user added.
 * The repo queries, icons, descriptions and installs read it, so the same page and dialog serve every repository.
 */
interface RepoSource {
  custom?: CustomRepo;
}

const RepoSourceContext = createContext<RepoSource>({});

export function RepoSourceProvider({ source, children }: { source: RepoSource; children: ReactNode }) {
  return <RepoSourceContext.Provider value={source}>{children}</RepoSourceContext.Provider>;
}

export function useRepoSource(): RepoSource {
  return useContext(RepoSourceContext);
}

/** The `repo` parameter for the bridge: the custom repository's apps.json address, or nothing for the official one. */
export const repoParam = (s: RepoSource) => (s.custom ? { repo: s.custom.url } : {});
/** Query-key part that keeps repositories apart. */
export const repoKey = (s: RepoSource) => s.custom?.url ?? 'official';
