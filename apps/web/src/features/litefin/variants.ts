import type { LitefinRelease } from '@lgdm/protocol';

/**
 * Litefin's webOS builds, from its release notes ("Which version to use?", .github/RELEASE_NOTES_FOOTER.md in
 * MoazSalem/litefin): one per hardware generation.
 */
export interface VariantInfo {
  label: string;
  /** Who it is for, in the release notes' words. */
  target: string;
  webos: string;
}

export const KNOWN_VARIANTS: Record<string, VariantInfo> = {
  Modern: { label: 'Modern', target: '2022 and newer TVs, the fastest', webos: 'webOS 22+' },
  Normal: { label: 'Normal', target: '2021 and newer TVs', webos: 'webOS 6+' },
  Legacy: { label: 'Legacy', target: '2018–2020 TVs', webos: 'webOS 4–5' },
  'Ultra-Legacy': { label: 'Ultra Legacy', target: '2014–2017 TVs', webos: 'webOS 1–3' },
  'Ultra-Legacy-NoService': { label: 'Ultra Legacy, no service', target: 'Ultra Legacy without Litefin’s background service — if Ultra Legacy won’t start', webos: '' },
};
const ORDER = Object.keys(KNOWN_VARIANTS);

export const variantInfo = (v: string): VariantInfo => (Object.hasOwn(KNOWN_VARIANTS, v) ? KNOWN_VARIANTS[v] : undefined) ?? { label: v.replace(/-/g, ' '), target: '', webos: '' };

/** Every variant in these releases, in the release notes' order (newest hardware first), unknown ones after. */
export function variantColumns(releases: readonly LitefinRelease[]): string[] {
  const all = new Set(releases.flatMap((r) => r.assets.map((a) => a.variant)));
  const known = ORDER.filter((v) => all.has(v));
  const other = [...all].filter((v) => !ORDER.includes(v)).sort();
  return [...known, ...other];
}

/**
 * The build the release notes point this TV at, by their webOS versions (as the TV reports them; webOS 22 reports 7.x):
 * Modern for webOS 22+, Normal for webOS 6+, Legacy for webOS 4+, Ultra Legacy below. Null when the version is unknown.
 */
export function suggestedVariant(osVersion: string | undefined): string | null {
  const major = Number(/^(\d+)/.exec(osVersion ?? '')?.[1]);
  if (!Number.isFinite(major) || major <= 0) return null;
  if (major >= 7) return 'Modern';
  if (major >= 6) return 'Normal';
  if (major >= 4) return 'Legacy';
  return 'Ultra-Legacy';
}

/** "1.9.0" vs "1.10.0" — numeric, part by part. Negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x));
  const pb = b.split(/[.-]/).map((x) => Number(x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return x - y;
  }
  return 0;
}
