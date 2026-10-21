import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Cloudflare Access in front of a LAN-mode bridge (2.0, opt-in: LGDM_CF_ACCESS_TEAM + LGDM_CF_ACCESS_AUD).
 *
 * Normally anything that arrives through Cloudflare is refused (lan.ts, forwardedProblem). With this set, a request
 * through Cloudflare is let in only when it carries a valid Access token — the `Cf-Access-Jwt-Assertion` header
 * Cloudflare adds to every request that passed the Access application's policy: signed by the team's keys (RS256),
 * for this application's audience tag, not expired, and (if LGDM_CF_ACCESS_ALLOW is set) for one of the listed emails
 * or service-token client ids. So a tunnel hostname without an Access application, a "Bypass" policy or a request that
 * skips Cloudflare's edge gets nothing, whatever Cloudflare's settings say. Access is the only login: the bridge has no
 * accounts of its own, just the pairing token.
 */
export interface CfAccessConfig {
  /** Team domain: https://<team>.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's audience (AUD) tag. */
  aud: string;
  /** Emails / service-token client ids allowed (lower-case, parseAllow). Required: never just "whoever Access lets in". */
  allow: string[];
}

export interface AccessIdentity {
  /** The email, or the service token's client id. */
  who: string;
  /** When the token expires (ms). */
  expiresAt: number;
}

/** "myteam", "myteam.cloudflareaccess.com" or "https://myteam.cloudflareaccess.com" → https://myteam.cloudflareaccess.com */
export function parseTeamDomain(raw: string): string {
  const v = raw.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
  const team = v.endsWith('.cloudflareaccess.com') ? v.slice(0, -'.cloudflareaccess.com'.length) : v;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(team)) {
    throw new Error(`LGDM_CF_ACCESS_TEAM ${raw}: not a Cloudflare Access team name (the part before .cloudflareaccess.com).`);
  }
  return `https://${team}.cloudflareaccess.com`;
}

export function parseAud(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{32,128}$/.test(v)) throw new Error('LGDM_CF_ACCESS_AUD: not an Access application audience (AUD) tag — copy it from the application’s overview.');
  return v;
}

class AccessDenied extends Error {}

const b64json = (part: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AccessDenied('not a token');
  return v as Record<string, unknown>;
};

/** Checks Cloudflare Access tokens. Keys come from the team's certs endpoint, cached for an hour. */
export class CfAccess {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private fetching: Promise<void> | null = null;

  constructor(
    readonly config: CfAccessConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The identity in a valid token, or throws with the reason (never with the token). */
  async verify(token: string | undefined): Promise<AccessIdentity> {
    try {
      if (!token) throw new AccessDenied('no Cloudflare Access token (is an Access application protecting this hostname?)');
      const parts = token.split('.');
      if (parts.length !== 3 || token.length > 16 * 1024) throw new AccessDenied('not a token');
      const [h, p, s] = parts as [string, string, string];
      const header = b64json(h);
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AccessDenied('unexpected token type');
      const key = await this.key(header.kid);
      if (!key || !verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) {
        throw new AccessDenied('bad signature');
      }
      const claims = b64json(p);
      const now = this.now() / 1000;
      const leeway = 60;
      if (claims.iss !== this.config.teamDomain) throw new AccessDenied('issued for another team');
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(this.config.aud)) throw new AccessDenied('issued for another Access application');
      if (typeof claims.exp !== 'number' || claims.exp + leeway < now) throw new AccessDenied('expired');
      if (typeof claims.nbf === 'number' && claims.nbf - leeway > now) throw new AccessDenied('not valid yet');
      if (claims.type !== 'app') throw new AccessDenied('not an Access application token');
      // A person (email), or a service token (common_name = its client id, empty sub, no email) — kept apart, so a
      // certificate or service token named like an email can't pass for that person.
      const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
      const serviceToken = !email && claims.sub === '' && typeof claims.common_name === 'string' ? claims.common_name.toLowerCase() : '';
      const who = email || serviceToken;
      if (!who) throw new AccessDenied('no identity in the token');
      const allowed = email ? this.config.allow.includes(email) : serviceToken.endsWith('.access') && this.config.allow.includes(serviceToken);
      if (!allowed) throw new AccessDenied(`${who} isn’t in LGDM_CF_ACCESS_ALLOW`);
      return { who, expiresAt: claims.exp * 1000 };
    } catch (e) {
      if (e instanceof AccessDenied) throw e;
      throw new AccessDenied('not a valid Cloudflare Access token');
    }
  }

  /** Read the team's keys at start, so a wrong team name shows up in the log straight away. */
  async warmUp(): Promise<void> {
    await this.fetchKeys();
    if (this.keys.size) console.log(`[bridge] Cloudflare Access: ${this.keys.size} signing key${this.keys.size === 1 ? '' : 's'} from ${this.config.teamDomain}`);
  }

  /** The key with this id: from the cache, or after fetching the team's keys again (at most once a minute). */
  private async key(kid: string): Promise<KeyObject | undefined> {
    const age = this.now() - this.fetchedAt;
    if (!this.keys.has(kid) ? age > 60_000 : age > 3_600_000) {
      this.fetching ??= this.fetchKeys().finally(() => (this.fetching = null));
      await this.fetching;
    }
    return this.keys.get(kid);
  }

  private async fetchKeys() {
    this.fetchedAt = this.now();
    let body: { keys?: (JsonWebKey & { kid?: string })[] };
    try {
      const res = await this.fetchImpl(`${this.config.teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as typeof body;
      if (!Array.isArray(body?.keys)) throw new Error('no keys in the answer');
    } catch (e) {
      console.warn(`[bridge] couldn't read the Cloudflare Access keys from ${this.config.teamDomain}: ${(e as Error).message}`);
      return; // keep the keys we had
    }
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        /* skip a key we can't read */
      }
    }
    if (next.size) this.keys = next;
  }
}

/**
 * LGDM_CF_ACCESS_ALLOW entries: emails (people) or service-token client ids (`….access`). Anything else is refused
 * rather than silently matching nothing.
 */
export function parseAllow(values: string[]): string[] {
  const allow = [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];
  for (const v of allow) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && !/^[a-z0-9]+\.access$/.test(v)) {
      throw new Error(`LGDM_CF_ACCESS_ALLOW ${v}: list email addresses (you@gmail.com) or service-token client ids (….access), not domains or groups.`);
    }
  }
  return allow;
}
