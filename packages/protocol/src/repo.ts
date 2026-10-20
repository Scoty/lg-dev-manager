import { z } from 'zod';

/**
 * The webOS Homebrew repository (repo.webosbrew.org/api). Shapes follow AppsRepoService / RepositoryItem /
 * PackageManifest in dev-manager-desktop (src/app/core/services/apps-repo.service.ts). The bridge fetches and
 * cleans these up (unknown fields dropped, URLs limited to http/https) before sending them to the UI.
 */
export const DEFAULT_REPO_URL = 'https://repo.webosbrew.org/api';

/**
 * A custom (unofficial) repository: the address of its `apps.json`, as Homebrew Channel's "Add repository" takes it
 * (e.g. https://repo.webosbrew.org/api/non-free/apps.json). Saved in the browser; `repo.check` turns what the user
 * typed into this form. https only — the bridge also refuses hosts on the local network.
 */
export const CustomRepoUrl = z
  .string()
  .max(2048)
  .refine((u) => {
    try {
      const p = new URL(u);
      // http is let through here only for the test rig (LGDM_TEST_ALLOW_LOCAL_REPOS); the bridge refuses it otherwise.
      return (p.protocol === 'https:' || p.protocol === 'http:') && !p.username && !p.password && !p.hash && /\.json$/i.test(p.pathname);
    } catch {
      return false;
    }
  }, 'Not an https address of a repository’s .json file');

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
  /** `repo.check`: the address answers, but not with a webOS Homebrew repository. */
  NotARepo: 'repo_not_a_repo',
  /** A custom repository address that isn't allowed (not https, or on the local network). */
  BadRepoUrl: 'repo_bad_url',
} as const;

/** Features a bridge supports beyond the protocol version, reported in `system.hello`. */
export const BridgeFeatures = { CustomRepos: 'customRepos' } as const;
