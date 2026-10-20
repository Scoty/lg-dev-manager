import { useMemo } from 'react';
import { useCustomRepos } from '../repos/store';
import { navWith, type NavSection } from './nav';

/** The sidebar / palette / breadcrumb manifest, with the user's custom repositories under Apps. */
export function useNav(): NavSection[] {
  const repos = useCustomRepos();
  return useMemo(() => navWith(repos), [repos]);
}
