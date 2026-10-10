import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_BRIDGE_PORT, DEV_ALLOWED_ORIGINS } from '@lgdm/protocol';
import type { WebUi } from './http/static.js';
import { standaloneUi } from './standalone.js';

export interface BridgeConfig {
  host: string;
  port: number;
  /** Origins allowed to open the WebSocket. Requests with any other Origin are rejected. */
  allowedOrigins: string[];
  /** Pairing token the UI must present in `system.hello`. */
  token: string;
  /** The built web UI to serve over HTTP (a folder, or the files packed into the standalone app), if any. */
  webRoot?: WebUi;
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
  const tighten = (path: string, mode: number) => {
    try {
      chmodSync(path, mode);
    } catch {
      /* not supported on this platform (Windows) */
    }
  };
  if (!reset) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown };
      if (typeof saved.token === 'string' && saved.token.length >= 16) {
        tighten(file, 0o600); // files from older versions were created readable by others
        return saved.token;
      }
    } catch {
      /* first run */
    }
  }
  const token = randomBytes(16).toString('base64url');
  // Only this user can read the folder and the file, from the moment they exist.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  tighten(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return token;
}

/**
 * The web UI that comes with the bridge, served at http://localhost:<port>/ (the "local page"): packed into the
 * standalone app, `web/` in the npm package, or the repository's own build (apps/web/dist) when run from a clone.
 * None: only lg.scoty.uk is used.
 */
export function bundledUi(): WebUi | undefined {
  const packed = standaloneUi();
  if (packed) return packed;
  for (const rel of ['../web/', '../../web/dist/']) {
    try {
      const dir = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(join(dir, 'index.html'))) return dir;
    } catch {
      /* no file location (the standalone app): nothing on disk to serve */
    }
  }
  return undefined;
}

/** `--allow-origin` values: real http(s) origins only (`null` would let sandboxed frames on any site in). */
export function parseOrigin(value: string): string {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new Error(`--allow-origin ${value}: not an origin like http://localhost:8080`);
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin === 'null') {
    throw new Error(`--allow-origin ${value}: only http:// and https:// origins can be allowed`);
  }
  return u.origin;
}

export function parseArgs(argv: string[]): BridgeConfig {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const all = (name: string) =>
    argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? [argv[i + 1]!] : []));

  // Always loopback: only programs on this computer can reach the bridge.
  const host = '127.0.0.1';
  const port = Number(get('port') ?? process.env.LGDM_PORT ?? DEFAULT_BRIDGE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a number from 1 to 65535`);
  const extra = [...all('allow-origin'), ...(process.env.LGDM_ALLOW_ORIGINS?.split(',') ?? [])]
    .filter((o) => o.trim())
    .map(parseOrigin);
  const self = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const dev = argv.includes('--dev');

  return {
    host,
    port,
    allowedOrigins: [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...(dev ? DEV_ALLOWED_ORIGINS : []), ...self, ...extra])],
    token: loadOrCreateToken(argv.includes('--reset-token')),
    webRoot: argv.includes('--no-ui') ? undefined : (get('web-root') ?? process.env.LGDM_WEB_ROOT ?? bundledUi()),
    repoUrl: process.env.LGDM_REPO_URL,
    lgeUrl: process.env.LGDM_LGE_URL,
    litefinUrl: process.env.LGDM_LITEFIN_URL,
    dev,
  };
}
