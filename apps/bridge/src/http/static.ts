import { createReadStream, statSync, type Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, posix, resolve, sep } from 'node:path';

/** The built web UI packed inside the standalone app: path relative to the UI root ("index.html", "assets/x.js") → bytes. */
export type WebFiles = ReadonlyMap<string, Uint8Array>;
/** Where the local page comes from: a folder on disk (npm package, clone) or files packed into the app. */
export type WebUi = string | WebFiles;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

/**
 * Sent with every file. The page's own <meta> CSP can't stop framing; a header can — no other site may put the UI in
 * a frame and trick clicks into TV actions.
 */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

/**
 * The security headers for this request. Cross-Origin-Opener-Policy only where browsers apply it — this computer or
 * https (behind a proxy); on a plain-HTTP LAN address (LAN mode) they ignore it and log an error in the console.
 */
const securityHeaders = (req: IncomingMessage): Record<string, string> => {
  const trustworthy = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '') || req.headers['x-forwarded-proto'] === 'https';
  if (trustworthy) return SECURITY_HEADERS;
  const { 'cross-origin-opener-policy': _coop, ...rest } = SECURITY_HEADERS;
  return rest;
};

const statOf = (file: string): Stats | null => {
  try {
    return statSync(file);
  } catch {
    return null;
  }
};

const headersFor = (req: IncomingMessage, name: string, size: number) => ({
  'content-type': MIME[extname(name)] ?? 'application/octet-stream',
  'content-length': size,
  'cache-control': name.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  ...securityHeaders(req),
});

/** Serves the UI from the files packed into the standalone app. Only names in the map exist, so nothing can escape it. */
function serveFiles(files: WebFiles, urlPath: string, req: IncomingMessage, res: ServerResponse): void {
  let name = posix.normalize(urlPath).replace(/^\/+/, '');
  if (!files.has(name)) name = 'index.html';
  const body = files.get(name);
  if (!body) {
    res.writeHead(404, { 'content-type': 'text/plain', ...securityHeaders(req) }).end('Web UI missing from this build.');
    return;
  }
  res.writeHead(200, headersFor(req, name, body.byteLength));
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Serves the built web UI. Unknown paths fall back to index.html (the UI uses hash routing). Never throws. */
export function serveStatic(root: WebUi, req: IncomingMessage, res: ServerResponse): void {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', ...securityHeaders(req) }).end();
      return;
    }
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    } catch {
      res.writeHead(400, securityHeaders(req)).end(); // malformed %-encoding
      return;
    }
    if (urlPath.includes('\0')) {
      res.writeHead(400, securityHeaders(req)).end();
      return;
    }
    if (typeof root !== 'string') {
      serveFiles(root, urlPath, req, res);
      return;
    }
    const base = resolve(root);
    let file = normalize(join(base, urlPath));
    if (!file.startsWith(base + sep) && file !== base) {
      res.writeHead(403, securityHeaders(req)).end();
      return;
    }
    let st = statOf(file);
    if (!st?.isFile()) {
      file = join(base, 'index.html');
      st = statOf(file);
    }
    if (!st?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain', ...securityHeaders(req) }).end('Web UI not built. Run `pnpm build`.');
      return;
    }
    res.writeHead(200, headersFor(req, file, st.size));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    // A file removed or unreadable between stat and open: end this response, not the bridge.
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(500, securityHeaders(req));
    res.end();
  }
}
