import { createReadStream, statSync, type Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

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

const statOf = (file: string): Stats | null => {
  try {
    return statSync(file);
  } catch {
    return null;
  }
};

/** Serves the built web UI. Unknown paths fall back to index.html (the UI uses hash routing). Never throws. */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', ...SECURITY_HEADERS }).end();
      return;
    }
    const base = resolve(root);
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end(); // malformed %-encoding
      return;
    }
    if (urlPath.includes('\0')) {
      res.writeHead(400, SECURITY_HEADERS).end();
      return;
    }
    let file = normalize(join(base, urlPath));
    if (!file.startsWith(base + sep) && file !== base) {
      res.writeHead(403, SECURITY_HEADERS).end();
      return;
    }
    let st = statOf(file);
    if (!st?.isFile()) {
      file = join(base, 'index.html');
      st = statOf(file);
    }
    if (!st?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain', ...SECURITY_HEADERS }).end('Web UI not built. Run `pnpm build`.');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    // A file removed or unreadable between stat and open: end this response, not the bridge.
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
    res.end();
  }
}
