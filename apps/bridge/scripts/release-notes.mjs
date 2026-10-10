// Release notes for a GitHub release of version X.Y.Z: that version's CHANGELOG.md section, then the downloads.
//   node apps/bridge/scripts/release-notes.mjs <version> <tag>  > notes.md
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [version, tag] = process.argv.slice(2);
if (!version || !tag) throw new Error('usage: release-notes.mjs <version> <tag>');
const changelog = readFileSync(fileURLToPath(new URL('../../../CHANGELOG.md', import.meta.url)), 'utf8');
const start = changelog.search(new RegExp(`^## ${version.replaceAll('.', '\\.')}\\b.*$`, 'm'));
if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
const rest = changelog.slice(start).split('\n').slice(1).join('\n');
const next = rest.search(/^## /m);
const section = (next < 0 ? rest : rest.slice(0, next)).trim();

const url = (file) => `https://github.com/Scoty/lg-dev-manager/releases/download/${tag}/${file}`;
const file = (os, arch, ext) => `lg-dev-manager-bridge-${version}-${os}-${arch}.${ext}`;
const row = (label, os, arch, ext) => `| ${label} | [${file(os, arch, ext)}](${url(file(os, arch, ext))}) |`;

process.stdout.write(`${section}

## ⬇️ The bridge app — no Node.js needed

Download the one for your computer, open it, and paste the pairing token it shows on the **Bridge** page of
https://lg.scoty.uk (it opens in your browser). Keep its window open while you use the app.

| Computer | Download |
|---|---|
${row('🪟 Windows (Intel/AMD, also runs on ARM)', 'windows', 'x64', 'exe')}
${row('🍎 macOS — Apple Silicon (M1 and newer)', 'macos', 'arm64', 'dmg')}
${row('🍎 macOS — Intel', 'macos', 'x64', 'dmg')}
${row('🐧 Linux x64', 'linux', 'x64', 'tar.gz')}
${row('🐧 Linux ARM64', 'linux', 'arm64', 'tar.gz')}

The first time:
- **Windows** may say "Windows protected your PC": click **More info → Run anyway**. The app isn't code-signed.
- **macOS** says Apple could not verify it: open **System Settings → Privacy & Security**, click **Open Anyway** next
  to lg-dev-manager-bridge and confirm. The app isn't notarized. The disk image has a "Read me" with the details.
- **Linux**: \`tar -xzf ${file('linux', 'x64', 'tar.gz')}\`, then \`./lg-dev-manager-bridge\`.

Prefer Node.js? \`npx lg-dev-manager-bridge@${version}\` runs the same bridge. Check a download against
\`SHA256SUMS.txt\` with \`shasum -a 256\` (macOS, Linux) or \`Get-FileHash\` (Windows).
`);
