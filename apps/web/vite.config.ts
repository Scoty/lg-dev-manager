/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const version = (pkg: string) => (JSON.parse(readFileSync(new URL(pkg, import.meta.url), 'utf8')) as { version: string }).version;

/**
 * Strict Content-Security-Policy for production builds: only this site's own code runs, and the page
 * may only open connections to itself and to a bridge on this computer (ws://127.0.0.1 / ws://localhost,
 * matching bridgeUrlProblem in src/bridge/settings.ts). Device settings never leave the browser except to
 * the paired bridge. Images are only data: / blob: (repo images come through the bridge). Not applied in dev,
 * where Vite/React inject inline scripts. Framing can't be forbidden from a <meta> CSP (frame-ancestors is
 * ignored there) and GitHub Pages can't send headers, so public/theme-init.js refuses to run in a frame.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'lgdm-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    ],
  };
}

// Relative base + hash routing: the same build works at https://lg.scoty.uk/ (GitHub Pages)
// and when served by the bridge (http://localhost:5199/).
export default defineConfig({
  base: './',
  plugins: [react(), cspPlugin()],
  // This site's version, and the newest bridge people can get (an older one connected gets an update notice).
  // The deploy sets LGDM_BRIDGE_RELEASE to the version published on npm (pages.yml) — the code's own version may
  // not be released yet. Empty means "don't know": no notice. Local builds and tests use the code's version.
  define: {
    __WEB_VERSION__: JSON.stringify(version('./package.json')),
    __BRIDGE_RELEASE__: JSON.stringify(process.env.LGDM_BRIDGE_RELEASE ?? version('../bridge/package.json')),
  },
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'jsdom', globals: false, setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
});
