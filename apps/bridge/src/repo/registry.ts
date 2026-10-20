import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { RepoErrorCodes } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { bridgeUploadBudget, type UploadBudget } from '../rpc/uploads.js';
import { isNonPublicAddress, RepoClient, type HttpTrace } from './repo.js';

/** Custom repositories kept in memory at once (index, images); the least recently used is dropped first. */
const MAX_CUSTOM = 8;

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
   * repo.check: is there a webOS Homebrew repository at what the user typed? Accepts the apps.json address (what
   * Homebrew Channel's "Add repository" takes), or the folder or site it is in (tries …/apps.json and
   * …/api/apps.json). Answers with the address to save and what the repository lists.
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
    u.search = '';
    const base = u.href.replace(/\/+$/, '');
    if (base === this.official.indexUrl || `${base}/apps.json` === this.official.indexUrl) {
      throw new RpcError(RepoErrorCodes.BadRepoUrl, 'That’s the official Homebrew repository — it’s already built in (Apps → Homebrew repo).');
    }
    const candidates = /\.json$/i.test(u.pathname) ? [base] : [`${base}/apps.json`, `${base}/api/apps.json`];
    const problems: string[] = [];
    for (const candidate of candidates) {
      const client = this.for(candidate);
      try {
        const { packages } = await client.list({ refresh: true, trace });
        if (!packages.length) {
          problems.push(`${candidate}: lists no apps this app can read`);
          continue;
        }
        return {
          url: candidate,
          apps: packages.length,
          installable: packages.filter((p) => p.manifest).length,
          sample: packages.slice(0, 3).map((p) => p.title),
        };
      } catch (e) {
        problems.push(`${candidate}: ${e instanceof RpcError ? `${e.message}${e.detail ? ` (${e.detail})` : ''}` : (e as Error).message}`);
      }
    }
    throw new RpcError(
      RepoErrorCodes.NotARepo,
      'There’s no webOS Homebrew repository at that address. Use the address of its apps.json — the one you’d add in Homebrew Channel.',
      problems.join('\n'),
    );
  }

  private assertAllowedScheme(u: URL) {
    if (u.protocol === 'https:' || (this.allowLocal && u.protocol === 'http:')) return;
    throw new RpcError(RepoErrorCodes.BadRepoUrl, 'Only https:// repositories can be added.', u.href);
  }
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
