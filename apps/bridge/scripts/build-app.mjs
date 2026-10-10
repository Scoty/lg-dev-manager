// Builds the standalone bridge app: Node.js and the bridge (with the local page, LICENSE and NOTICE) in one executable,
// so it runs without Node.js installed. Uses Node's single executable applications
// (https://nodejs.org/api/single-executable-applications.html): the bridge is bundled into one CommonJS file, packed
// with the web UI into a "blob", and the blob is injected into a copy of the node binary running this script.
//
// Build on the platform you are building for (CI uses one runner per OS and CPU): `pnpm build`, then
//   node apps/bridge/scripts/build-app.mjs
// Output in apps/bridge/release/: lg-dev-manager-bridge-<version>-<os>-<arch>.exe | .tar.gz | .dmg, plus the bare
// executable in apps/bridge/release/bin/ for testing.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const root = here('../../../');
const bridgeDir = here('../');
const webDist = join(root, 'apps/web/dist');
const out = join(bridgeDir, 'release');
const work = join(out, 'work');
const version = JSON.parse(readFileSync(join(bridgeDir, 'package.json'), 'utf8')).version;

const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
if (!os) throw new Error(`Unsupported platform ${process.platform}`);
const arch = process.arch; // x64 | arm64
const exe = process.platform === 'win32' ? 'lg-dev-manager-bridge.exe' : 'lg-dev-manager-bridge';
const name = `lg-dev-manager-bridge-${version}-${os}-${arch}`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

if (!existsSync(join(webDist, 'index.html'))) throw new Error('apps/web/dist is missing: run `pnpm build` at the repository root first.');
rmSync(out, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. One CommonJS file with every dependency. The optional native add-ons of ssh2 (its crypto binding, cpu-features)
//    and ws (bufferutil, utf-8-validate) stay out: they are loaded in try/catch and both fall back to plain JS, the
//    same code the npm package runs when they aren't installed.
const bundle = join(work, 'bridge.cjs');
const result = await build({
  entryPoints: [join(bridgeDir, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundle,
  external: ['*.node', 'cpu-features', 'bufferutil', 'utf-8-validate'],
  legalComments: 'none',
  metafile: true,
  logOverride: { 'empty-import-meta': 'silent' }, // the app has no file location; config.ts checks for it
});

// 2. Licenses: this project's LICENSE and NOTICE, and the licenses of everything packed in — Node.js itself and the
//    npm packages in the bundle. `lg-dev-manager-bridge --license` prints them all.
const require = createRequire(import.meta.url);
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const abs = resolve(input).split(sep).join('/');
  const m = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(abs);
  if (m && !packages.has(m[2])) packages.set(m[2], m[1]);
}
const sections = [];
for (const [pkg, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(f));
  if (!file) throw new Error(`No license file in ${pkg}: add it by hand before shipping`);
  const kind = meta.license ?? meta.licenses?.map((l) => l.type).join(' OR ') ?? 'see below';
  sections.push(`${pkg} ${meta.version} (${kind})\n\n${readFileSync(join(dir, file), 'utf8').trim()}`);
}
// Node's own license sits next to its install (…/bin/node → …/LICENSE on macOS and Linux, beside node.exe on Windows).
const nodeLicense = [join(dirname(process.execPath), '..', 'LICENSE'), join(dirname(process.execPath), 'LICENSE')].find(existsSync);
if (!nodeLicense) throw new Error(`Node.js LICENSE not found next to ${process.execPath}`);
sections.unshift(`Node.js ${process.version}\n\n${readFileSync(nodeLicense, 'utf8').trim()}`);
writeFileSync(join(work, 'THIRD-PARTY-LICENSES.txt'), `Software packed into the LG Dev Manager bridge app\n\n${sections.join(`\n\n${'='.repeat(78)}\n\n`)}\n`);

// 3. The web UI (the local page), with the same files left out as in the npm package (see prepack.mjs).
const skip = (f) => f.endsWith('.map') || f.endsWith('.woff') || f === 'CNAME';
const webFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (!skip(entry)) webFiles.push(relative(webDist, full).split(sep).join('/'));
  }
};
walk(webDist);
writeFileSync(join(work, 'web-manifest.json'), JSON.stringify(webFiles));

const assets = {
  'web-manifest.json': join(work, 'web-manifest.json'),
  LICENSE: join(root, 'LICENSE'),
  NOTICE: join(root, 'NOTICE'),
  'THIRD-PARTY-LICENSES.txt': join(work, 'THIRD-PARTY-LICENSES.txt'),
  ...Object.fromEntries(webFiles.map((f) => [`web/${f}`, join(webDist, f)])),
};
const blob = join(work, 'sea-prep.blob');
writeFileSync(
  join(work, 'sea-config.json'),
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }, null, 2),
);
run(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')]);

// 4. A copy of this node binary with the blob injected. macOS needs the signature removed first and an ad-hoc one
//    after (Apple Silicon refuses to run unsigned code); Windows runs it unsigned.
const bin = join(out, 'bin');
mkdirSync(bin, { recursive: true });
const target = join(bin, exe);
copyFileSync(process.execPath, target);
chmodSync(target, 0o755);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', target]);
const postject = join(dirname(require.resolve('postject/package.json')), 'dist', 'cli.js');
run(process.execPath, [
  postject,
  target,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);
if (process.platform === 'darwin') run('codesign', ['--sign', '-', target]);

// 5. Quick check that it starts, then the download for this platform.
const printed = execFileSync(target, ['--version'], { encoding: 'utf8' }).trim();
if (printed !== version) throw new Error(`The app printed version "${printed}", expected ${version}`);

if (process.platform === 'win32') {
  // A single portable .exe.
  copyFileSync(target, join(out, `${name}.exe`));
} else if (process.platform === 'linux') {
  // tar keeps the executable bit, which a bare download would lose.
  run('tar', ['-czf', join(out, `${name}.tar.gz`), '-C', bin, exe]);
} else {
  // A disk image with the app and a short note on opening it the first time (it isn't notarized by Apple).
  const dmgDir = join(work, 'dmg');
  mkdirSync(dmgDir);
  cpSync(target, join(dmgDir, exe));
  writeFileSync(join(dmgDir, 'Read me.txt'), readFileSync(here('app-readme-macos.txt'), 'utf8'));
  const args = ['create', '-volname', `LG Dev Manager Bridge ${version}`, '-srcfolder', dmgDir, '-fs', 'HFS+', '-format', 'UDZO', '-ov', join(out, `${name}.dmg`)];
  // hdiutil on CI runners now and then fails with "Resource busy"; a retry is the usual cure.
  for (let attempt = 1; ; attempt++) {
    try {
      run('hdiutil', args);
      break;
    } catch (e) {
      if (attempt === 3) throw e;
      execFileSync('sleep', ['5']);
    }
  }
}
console.log(`build-app: ${name} (${(statSync(target).size / 1048576).toFixed(0)} MB executable, ${webFiles.length} web files)`);
