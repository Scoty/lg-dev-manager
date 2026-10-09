import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_BRIDGE_PORT } from '@lgdm/protocol';

export interface BridgeConfig {
  host: string;
  port: number;
  /** Origins allowed to open the WebSocket. Requests with any other Origin are rejected. */
  allowedOrigins: string[];
  /** Pairing token the UI must present in `system.hello`. */
  token: string;
  /** Directory with the built web UI to serve over HTTP, if any. */
  webRoot?: string;
  /** Homebrew repository API (default repo.webosbrew.org; LGDM_REPO_URL overrides, for tests). */
  repoUrl?: string;
  /** LG's Developer Mode session service (default developer.lge.com; LGDM_LGE_URL overrides, for tests). */
  lgeUrl?: string;
  /** Litefin's GitHub releases API (default api.github.com/repos/MoazSalem/litefin; LGDM_LITEFIN_URL overrides, for tests). */
  litefinUrl?: string;
  dev: boolean;
}


const stateDir = () => process.env.LGDM_STATE_DIR ?? join(homedir(), '.lg-dev-manager');

/** Loads the persisted pairing token, creating one on first run, so pairing survives restarts. */
export function loadOrCreateToken(reset = false): string {
  if (process.env.LGDM_TOKEN) return process.env.LGDM_TOKEN;
  const dir = stateDir();
  const file = join(dir, 'bridge.json');
  if (!reset) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { token?: string };
      if (saved.token) return saved.token;
    } catch {
      /* first run */
    }
  }
  const token = randomBytes(16).toString('base64url');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ token }, null, 2));
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not supported on this platform */
  }
  return token;
}

export function parseArgs(argv: string[]): BridgeConfig {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const all = (name: string) =>
    argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]!] : []));

  // Always loopback: only programs on this computer can reach the bridge.
  const host = '127.0.0.1';
  const port = Number(get('port') ?? process.env.LGDM_PORT ?? DEFAULT_BRIDGE_PORT);
  const extra = [...all('allow-origin'), ...(process.env.LGDM_ALLOW_ORIGINS?.split(',') ?? [])]
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const self = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

  return {
    host,
    port,
    allowedOrigins: [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...self, ...extra])],
    token: loadOrCreateToken(argv.includes('--reset-token')),
    webRoot: get('web-root') ?? process.env.LGDM_WEB_ROOT,
    repoUrl: process.env.LGDM_REPO_URL,
    lgeUrl: process.env.LGDM_LGE_URL,
    litefinUrl: process.env.LGDM_LITEFIN_URL,
    dev: argv.includes('--dev'),
  };
}
