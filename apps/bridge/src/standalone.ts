import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sea from 'node:sea';
import type { WebFiles } from './http/static.js';

/**
 * How this bridge was installed, so the site can say how to update it: `app` — the standalone download from the
 * GitHub releases (a Node.js single executable application, scripts/build-app.mjs); `npm` — npx; `source` — a clone.
 */
export type Distribution = 'app' | 'npm' | 'source';

/** Running as the standalone app (Node.js and the bridge packed into one executable)? */
export function isStandalone(): boolean {
  try {
    return sea.isSea();
  } catch {
    return false;
  }
}

export function distribution(): Distribution {
  if (isStandalone()) return 'app';
  // A clone has the TypeScript sources next to dist/; the npm package ships dist/ only.
  try {
    return existsSync(fileURLToPath(new URL('../src/', import.meta.url))) ? 'source' : 'npm';
  } catch {
    return 'npm';
  }
}

/** Name of the asset listing the packed web UI files (written by scripts/build-app.mjs). */
export const WEB_MANIFEST_ASSET = 'web-manifest.json';

/** The web UI packed into the standalone app, or undefined when it has none (or this isn't the app). */
export function standaloneUi(): WebFiles | undefined {
  if (!isStandalone()) return undefined;
  try {
    const names = JSON.parse(sea.getAsset(WEB_MANIFEST_ASSET, 'utf8')) as unknown;
    if (!Array.isArray(names)) return undefined;
    const files = new Map<string, Uint8Array>();
    for (const name of names) {
      if (typeof name === 'string') files.set(name, new Uint8Array(sea.getAsset(`web/${name}`)));
    }
    return files.has('index.html') ? files : undefined;
  } catch {
    return undefined;
  }
}

/** `--license`: the app carries the license texts inside; the npm package and a clone have them as files. */
export function licenseText(): string {
  if (!isStandalone()) {
    return `Apache-2.0. See the LICENSE and NOTICE files next to this program, or https://github.com/Scoty/lg-dev-manager/blob/main/LICENSE\n`;
  }
  const rule = `\n${'='.repeat(78)}\n\n`;
  return ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.txt'].map((f) => sea.getAsset(f, 'utf8').trim()).join(rule) + '\n';
}
