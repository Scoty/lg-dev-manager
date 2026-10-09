// Runs before `npm pack` / `npm publish`: bundles the built web UI (the local page) and the license files into the
// package. Build first: `pnpm build` at the repository root.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ui = here('../../web/dist/');
if (!existsSync(`${ui}index.html`)) throw new Error('apps/web/dist is missing: run `pnpm build` at the repository root first.');
if (!existsSync(here('../dist/cli.js'))) throw new Error('apps/bridge/dist is missing: run `pnpm build` at the repository root first.');
rmSync(here('../web/'), { recursive: true, force: true });
// Source maps stay out of the package (they're large and only useful for development).
cpSync(ui, here('../web/'), { recursive: true, filter: (src) => !src.endsWith('.map') && !src.endsWith('/CNAME') });
for (const f of ['LICENSE', 'NOTICE']) cpSync(here(`../../../${f}`), here(`../${f}`));
console.log('prepack: bundled the web UI, LICENSE and NOTICE');
