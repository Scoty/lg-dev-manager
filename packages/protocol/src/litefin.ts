import { z } from 'zod';

/**
 * M8 — Litefin repo: every webOS build of the latest Litefin releases, straight from its GitHub releases
 * (https://github.com/MoazSalem/litefin/releases). The Homebrew repository only carries one build per version.
 */

/** Litefin's webOS app id (appinfo.json and the IPKs' control file). All variants share it. */
export const LITEFIN_APP_ID = 'org.litefin.app';
export const LITEFIN_RELEASES_PAGE = 'https://github.com/MoazSalem/litefin/releases';
/** Releases listed (newest first, published releases only). */
export const LITEFIN_RELEASE_COUNT = 5;

/** A variant name as it appears in the file name (`Litefin-<version>-webOS-<variant>.ipk`), e.g. `Ultra-Legacy`. */
export const LitefinVariant = z.string().min(1).max(64).regex(/^[A-Za-z0-9][\w.-]*$/, 'Not a variant name');

export const LitefinAsset = z.object({
  variant: LitefinVariant,
  /** File name, e.g. Litefin-1.9.0-webOS-Normal.ipk */
  name: z.string(),
  size: z.number(),
  /** From GitHub's asset digest, when it has one. */
  sha256: z.string().optional(),
});
export type LitefinAsset = z.infer<typeof LitefinAsset>;

export const LitefinRelease = z.object({
  tag: z.string(),
  /** The tag without its leading `v` — what the installed app reports. */
  version: z.string(),
  title: z.string(),
  publishedAt: z.string(),
  assets: z.array(LitefinAsset),
});
export type LitefinRelease = z.infer<typeof LitefinRelease>;

export const LitefinErrorCodes = {
  Unreachable: 'litefin_unreachable',
  BadResponse: 'litefin_bad_response',
  NotFound: 'litefin_not_found',
  RateLimited: 'litefin_rate_limited',
} as const;
