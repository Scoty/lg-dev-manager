import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { RepoErrorCodes } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { bridgeUploadBudget, type UploadBudget } from '../rpc/uploads.js';
import { RepoClient } from './repo.js';
import { finalUrl, isNonPublicAddress, type HttpTrace } from '../net/fetch.js';

const noTrace: HttpTrace = (_host, _what, run) => run();

/** Custom repositories kept in memory at once (index, images); the least recently used is dropped first. */
const MAX_CUSTOM = 8;
/** How long repo.check keeps trying the addresses it guesses from what the user typed. */
const CHECK_BUDGET_MS = 45_000;

/**
 * The official Homebrew repository plus the custom ones the user added. The browser keeps the list (it is a user
 * setting) and names a custom repository by its `apps.json` address in each call; the bridge only keeps a client per
 * address in memory, like its cache of the official index. Custom repositories must be https on a public address —
 * the browser can't make the bridge read this computer or the local network through one.
 */
export class RepoRegistry {
  private custom = new Map<string, RepoClient>();

  constructor(
    readonly official: RepoClient,
    /** Test rig only: allow http and local addresses for custom repositories (the mock repo runs on 127.0.0.1). */
    private readonly allowLocal = process.env.LGDM_TEST_ALLOW_LOCAL_REPOS === '1',
    private readonly budget: UploadBudget = bridgeUploadBudget,
  ) {}

  /** The client for `url` (a custom repository's apps.json), or the official repository when there is none. */
  for(url?: string): RepoClient {
    if (!url || url === this.official.indexUrl) return this.official;
    const hit = this.custom.get(url);
    if (hit) {
      this.custom.delete(url);
      this.custom.set(url, hit);
      return hit;
    }
    this.assertAllowedScheme(new URL(url));
    const client = new RepoClient(url, this.budget, { custom: true, trustOwnOrigin: this.allowLocal });
    this.custom.set(url, client);
    for (const key of this.custom.keys()) {
      if (this.custom.size <= MAX_CUSTOM) break;
      this.custom.delete(key);
    }
    return client;
  }

  /**
   * repo.check: is there a webOS Homebrew repository at what the user typed? Repository owners publish them in many
   * ways, and Homebrew Channel takes any address that answers with the index, so this tries, in order:
   * - the address itself — an apps.json or repo.json, but also a pastebin "raw" page, a file without an extension, a
   *   folder whose index page is the JSON, or `…/backup.json/` with a trailing slash (GitHub Pages serves those);
   * - for a site or folder, the names repositories use: apps.json (the official repo, repogen) and repo.json (many
   *   third-party ones, e.g. webosappclub.github.io/repo.json), at the top or under api/.
   * Redirects are followed first (short links like tinyurl.com/…, moved GitHub Pages sites) — every hop https and
   * public — and the address saved is where they end, so later requests go straight there. Answers with that address
   * and what the repository lists.
   */
  async check(input: string, trace?: HttpTrace): Promise<{ url: string; apps: number; installable: number; sample: string[] }> {
    let text = input.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      throw new RpcError(RepoErrorCodes.BadRepoUrl, 'That isn’t a web address.');
    }
    if (u.username || u.password) throw new RpcError(RepoErrorCodes.BadRepoUrl, 'Addresses with a user name or password aren’t supported.');
    this.assertAllowedScheme(u);
    if (!this.allowLocal) await assertPublicRepoHost(u);
    u.hash = '';
    // A GitHub page about the file (github.com/<owner>/<repo>/blob/<branch>/repo.json) is HTML; the file itself is on
    // raw.githubusercontent.com — what a repository's README usually gives for Homebrew Channel.
    u = githubRaw(u) ?? u;
    this.assertNotOfficial(u.href);
    const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    const looksLikeFile = /\.json$/i.test(base);
    const candidates = [
      ...new Set([
        u.href,
        ...(looksLikeFile ? [base] : u.search ? [] : [`${base}/apps.json`, `${base}/repo.json`, `${base}/api/apps.json`, `${base}/api/repo.json`]),
      ]),
    ];
    const problems: string[] = [];
    // Slow or unanswering servers can't keep the check (and the page waiting on it) going for minutes.
    const deadline = Date.now() + CHECK_BUDGET_MS;
    for (const candidate of candidates) {
      if (Date.now() > deadline) {
        problems.push(`Stopped trying after ${CHECK_BUDGET_MS / 1000} seconds.`);
        break;
      }
      try {
        const found = await this.tryIndex(candidate, trace);
        if (found) return found;
      } catch (e) {
        if (e instanceof RpcError && e.code === RepoErrorCodes.BadRepoUrl) throw e;
        problems.push(`${candidate}: ${e instanceof RpcError ? `${e.message}${e.detail ? ` (${e.detail})` : ''}` : (e as Error).message}`);
      }
    }
    throw new RpcError(
      RepoErrorCodes.NotARepo,
      'There’s no webOS Homebrew repository at that address. Use the address its author gives for Homebrew Channel.',
      problems.join('\n'),
    );
  }

  /** The repository at `candidate` (after its redirects), or an error saying why there isn't one. */
  private async tryIndex(candidate: string, trace?: HttpTrace) {
    const host = new URL(candidate).host;
    const resolved = await (trace ?? noTrace)(host, `GET ${candidate} (following redirects)`, () => finalUrl(candidate, 15_000, this.allowLocal));
    let target = new URL(resolved);
    target = githubRaw(target) ?? target;
    target.hash = '';
    this.assertNotOfficial(target.href);
    const { packages } = await this.for(target.href).list({ refresh: true, trace });
    return {
      url: target.href,
      apps: packages.length,
      installable: packages.filter((p) => p.manifest).length,
      sample: packages.slice(0, 3).map((p) => p.title),
    };
  }

  private assertNotOfficial(href: string) {
    const official = this.official.indexUrl;
    const bare = href.replace(/\/+$/, '');
    if (bare === official || `${bare}/apps.json` === official) {
      throw new RpcError(RepoErrorCodes.BadRepoUrl, 'That’s the official Homebrew repository — it’s already built in (Apps → Homebrew repo).');
    }
  }

  private assertAllowedScheme(u: URL) {
    if (u.protocol === 'https:' || (this.allowLocal && u.protocol === 'http:')) return;
    throw new RpcError(RepoErrorCodes.BadRepoUrl, 'Only https:// repositories can be added.', u.href);
  }
}

/** github.com/<owner>/<repo>/blob|raw/<branch>/<file>.json → its raw.githubusercontent.com address; else null. */
export function githubRaw(u: URL): URL | null {
  const gh = u.host === 'github.com' ? /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+\.json)$/i.exec(u.pathname) : null;
  return gh ? new URL(`https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`) : null;
}

/** A custom repository must be on the public internet: never this computer or the local network. */
async function assertPublicRepoHost(u: URL) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new RpcError(RepoErrorCodes.Unreachable, `Couldn’t find ${host}. Check the address and this computer’s internet connection.`);
  if (addresses.some(isNonPublicAddress)) {
    throw new RpcError(
      RepoErrorCodes.BadRepoUrl,
      'That address is on this computer or your local network. Only repositories on the public internet can be added.',
      u.href,
    );
  }
}
