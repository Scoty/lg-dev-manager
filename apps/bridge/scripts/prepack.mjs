// Runs before `npm pack` / `npm publish`: bundles the built web UI (the local page), the license files and the
// project README into the package. Build first: `pnpm build` at the repository root.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ui = here('../../web/dist/');
if (!existsSync(`${ui}index.html`)) throw new Error('apps/web/dist is missing: run `pnpm build` at the repository root first.');
if (!existsSync(here('../dist/cli.js'))) throw new Error('apps/bridge/dist is missing: run `pnpm build` at the repository root first.');
rmSync(here('../web/'), { recursive: true, force: true });
// Left out of the package (the website keeps everything):
// - source maps: large, only useful for development;
// - .woff fonts: every browser that can run the app loads the .woff2 copy of the same font and never asks for these
//   (they halve the package);
// - CNAME: GitHub Pages' domain file.
const skip = (src) => src.endsWith('.map') || src.endsWith('.woff') || src.endsWith('/CNAME');
cpSync(ui, here('../web/'), { recursive: true, filter: (src) => !skip(src) });
for (const f of ['LICENSE', 'NOTICE']) cpSync(here(`../../../${f}`), here(`../${f}`));

// The npm page shows the project README. Its relative links point into the repository, so they become absolute:
// images to the raw files, everything else to GitHub.
const REPO = 'https://github.com/Scoty/lg-dev-manager';
const RAW = 'https://raw.githubusercontent.com/Scoty/lg-dev-manager/main';
const readme = readFileSync(here('../../../README.md'), 'utf8').replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_, path) => {
  const clean = path.replace(/^\.?\//, '');
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(clean) ? `](${RAW}/${clean})` : `](${REPO}/blob/main/${clean})`;
});
writeFileSync(here('../README.md'), readme);
console.log('prepack: bundled the web UI (no .woff), LICENSE, NOTICE and the README');
