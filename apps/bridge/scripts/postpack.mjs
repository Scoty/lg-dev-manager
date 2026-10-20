// Runs after `npm pack` / `pnpm pack` / `npm publish`: removes what prepack.mjs copied into apps/bridge for the
// tarball (the built site, LICENSE, NOTICE, README). Left behind, a clone's `pnpm bridge` used to serve that stale
// copy of the site instead of the fresh build.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
for (const p of ['../web/', '../LICENSE', '../NOTICE', '../README.md']) rmSync(here(p), { recursive: true, force: true });
console.log('postpack: removed the copies made for the package (web/, LICENSE, NOTICE, README.md)');
