import { z } from 'zod';

/**
 * The webOS Homebrew repository (repo.webosbrew.org/api). Shapes follow AppsRepoService / RepositoryItem /
 * PackageManifest in dev-manager-desktop (src/app/core/services/apps-repo.service.ts). The bridge fetches and
 * cleans these up (unknown fields dropped, URLs limited to http/https) before sending them to the UI.
 */
export const DEFAULT_REPO_URL = 'https://repo.webosbrew.org/api';

/** An absolute http(s) URL — never `javascript:` or `data:`, since the UI uses these as links and images. */
export const WebUrl = z
  .string()
  .max(2048)
  .refine((u) => {
    try {
      const p = new URL(u).protocol;
      return p === 'https:' || p === 'http:';
    } catch {
      return false;
    }
  }, 'Not an http(s) URL');

export const RepoManifest = z.object({
  id: z.string(),
  version: z.string(),
  type: z.string().optional(),
  title: z.string().optional(),
  appDescription: z.string().optional(),
  sourceUrl: WebUrl.optional(),
  /** `'optional'`: works without root, does more with it. */
  rootRequired: z.union([z.boolean(), z.literal('optional')]).optional(),
  ipkUrl: WebUrl,
  ipkHash: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/i) }).optional(),
  ipkSize: z.number().nonnegative().optional(),
});
export type RepoManifest = z.infer<typeof RepoManifest>;

export const RepoScreenshot = z.object({
  url: WebUrl,
  caption: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const RepoPackage = z.object({
  id: z.string(),
  title: z.string(),
  iconUri: WebUrl.optional(),
  detailIconUri: WebUrl.optional(),
  shortDescription: z.string().optional(),
  featured: z.boolean().optional(),
  manifest: RepoManifest.optional(),
  manifestBeta: RepoManifest.optional(),
  /** `webosRelease` is a semver range (">=5.0"); `deviceSoC` lists SoCs, `!soc` excludes one. */
  requirements: z
    .object({
      webosRelease: z.string().optional(),
      deviceSoC: z.array(z.string()).optional(),
    })
    .optional(),
  screenshots: z.array(RepoScreenshot).optional(),
  /** The full description (HTML) is available through `repo.description`. */
  hasDescription: z.boolean(),
});
export type RepoPackage = z.infer<typeof RepoPackage>;

export const RepoErrorCodes = {
  Unreachable: 'repo_unreachable',
  BadResponse: 'repo_bad_response',
  NotFound: 'repo_not_found',
  NoManifest: 'repo_no_manifest',
  DownloadFailed: 'download_failed',
} as const;
