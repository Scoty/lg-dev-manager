import eq from 'semver/functions/eq';
import gt from 'semver/functions/gt';
import satisfies from 'semver/functions/satisfies';
import coerce from 'semver/functions/coerce';
import validRange from 'semver/ranges/valid';
import type { RepoManifest, RepoPackage } from '@lgdm/protocol';

/**
 * Is the repository's version newer than the installed one? Port of PackageManifest.hasUpdate
 * (dev-manager-desktop src/app/core/services/apps-repo.service.ts): versions may carry a 4th segment
 * ("1.2.3.4"), compared numerically (or as text) when the first three are equal. Null when unknown.
 */
export function hasUpdate(repoVersion: string | undefined, installed: string | undefined): boolean | null {
  if (!repoVersion || !installed) return null;
  const split = (v: string) => {
    const segs = v.split('.', 4);
    return segs.length > 3 ? { base: segs.slice(0, 3).join('.'), suffix: segs[3]! } : { base: v, suffix: '' };
  };
  const a = split(repoVersion);
  const b = split(installed);
  try {
    if ((a.suffix || b.suffix) && eq(a.base, b.base, true)) {
      const na = Number(a.suffix);
      const nb = Number(b.suffix);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return na > nb;
      return a.suffix.localeCompare(b.suffix) > 0;
    }
    return gt(a.base, b.base, true);
  } catch {
    // Not semver at all ("1.2", "2024-01"): fall back to a loose comparison.
    const ca = coerce(repoVersion);
    const cb = coerce(installed);
    if (ca && cb) return gt(ca, cb);
    return repoVersion !== installed ? null : false;
  }
}

export type IncompatibleReason = 'release' | 'soc' | 'root';

export const INCOMPATIBLE_TEXT: Record<IncompatibleReason, string> = {
  root: 'This app needs root, but this TV isn’t rooted.',
  soc: 'This app isn’t made for this TV’s chip (SoC).',
  release: 'This app needs a different webOS version.',
};

/**
 * Why an app may not work on this TV (RepositoryItem.checkIncompatibility + PackageRequirements): webOS
 * version range, SoC allow/deny list, and root. Unknown facts don't count against the app. Null if fine.
 */
export function incompatibility(
  pkg: RepoPackage,
  tv: { osVersion?: string; socName?: string } | undefined,
  hb: { root?: boolean } | undefined,
  manifest: RepoManifest | undefined = pkg.manifest,
): IncompatibleReason[] | null {
  const out: IncompatibleReason[] = [];
  const req = pkg.requirements;
  // A range semver can't read doesn't count against the app.
  if (tv?.osVersion && req?.webosRelease && validRange(req.webosRelease, { loose: true })) {
    const version = coerce(tv.osVersion);
    if (version && !satisfies(version, req.webosRelease, { loose: true })) out.push('release');
  }
  if (tv?.socName && req?.deviceSoC?.length) {
    const exclude = req.deviceSoC.filter((s) => s.startsWith('!')).map((s) => s.slice(1));
    const include = req.deviceSoC.filter((s) => !s.startsWith('!'));
    if (include.length > 0 && !include.includes(tv.socName)) out.push('soc');
    else if (exclude.includes(tv.socName)) out.push('soc');
  }
  if (hb?.root === false && manifest?.rootRequired === true) out.push('root');
  return out.length ? out : null;
}

export type RepoAppState = 'install' | 'update' | 'installed';

/** What the main button for a repository app does on this TV. */
export function stateOf(pkg: RepoPackage, installedVersion: string | undefined): RepoAppState {
  if (installedVersion === undefined) return 'install';
  return hasUpdate(pkg.manifest?.version, installedVersion) ? 'update' : 'installed';
}

export const fmtSize = (n?: number) =>
  n === undefined ? undefined : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
