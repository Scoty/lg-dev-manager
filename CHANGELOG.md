# Changelog

## 2.0.0 — unreleased

- 🔗 **Pairing links.** The bridge prints a link that pairs a browser with one click (`…/#/pair?token=…`); the app
  opens lg.scoty.uk ready to pair. The token stays in the browser (it's after `#`), is removed from the address bar,
  and is checked with the bridge before it's saved.
- 🏠 **LAN mode** (for running the bridge on a home server or NAS, as the Docker image does): `--listen` and
  `--public-url` share the bridge with browsers on your network, which open the page it serves. Off unless asked for.
  Only devices on your local network get in, nothing forwarded from the internet (e.g. a Cloudflare Tunnel), pairing
  attempts are rate-limited per device, and the page warns that plain HTTP isn't encrypted.
- 🐳 **Docker image** `ghcr.io/scoty/lg-dev-manager` (amd64, arm64) and a `compose.yaml`: the bridge and the web app
  on a home server, in LAN mode, as a non-root user on a read-only filesystem with a health check. `docker compose
  up -d`, open the pairing link from the logs, done. The update notice says to `docker compose pull`.
- 🗄️ **TVs stored on the bridge** (`--store`, on in the Docker image): the TVs with their logins, the custom
  repositories and the screenshots live in the bridge's data folder, so every browser and phone paired with it sees
  the same ones, and changes show up everywhere at once. A TV's password or key goes to the bridge once and is never
  sent back to a browser, and the bridge sends it only to that TV (it checks the TV's SSH host key first). TVs saved in a browser before can be moved there in one click (Devices page).
- 📱 **Phones and tablets**, through a bridge on your network: every page fits a phone screen, the terminal has a bar
  with the keys a phone keyboard lacks (Esc, Tab, Ctrl+C/D/Z/L/R, arrows, `| ~ / -`), bigger touch targets, no zooming
  into text fields on iPhone, and TVs are listed as cards. Elsewhere the phone notice points to Docker.
- Copy buttons, the terminal and screenshots also work on pages served over plain HTTP.
- The bridge stops at once on SIGTERM (`docker stop`).
- README: running it on a NAS or home server, with an example for Ugreen NAS
  (`examples/ugreen-nas/compose.yaml`); the local page is suggested first, lg.scoty.uk second. The bridge prints them
  in that order too.
- Fixed: after an install, the dialog said “Installed by Homebrew Channel” on rooted TVs, even for apps from a custom
  repository or Litefin. It now says where the app came from.
- Update badges on the Installed page say they're the official Homebrew build, and updating from there asks first:
  the TV doesn't record where an app came from, so it may replace a build from a custom repository or an IPK file.

## 1.0.5 — 2026-10-20

- 🧩 **Custom repositories.** Add other webOS Homebrew repositories under **Setup → Custom repos**, using the same
  addresses Homebrew Channel takes: an `apps.json` or `repo.json`, a GitHub link to the file, a short link, a pastebin
  "raw" page, or just the site the repository is on. Repositories whose apps point to a separate manifest
  (`manifestUrl`, e.g. Aurora's) work too. The bridge checks that the address really is a repository before it's
  added (and asks first if a short link leads to another site); each one then gets its own page under **Apps** with
  search, details and install, and can be renamed. They're saved in your browser and included in **Export backup**.
  Needs bridge 1.0.5.
- 🛡️ **Unofficial means untrusted.** Custom repositories come with clear warnings that they can contain untested apps
  or malware, a box to tick before adding one, and a question before every install — which also says when the app
  would replace one with the same id. The bridge fetches everything they point to over https from the public
  internet only (never your computer or local network), downloads and checks their IPKs itself instead of letting the
  TV fetch them, refuses an IPK that installs anything but the listed app, and never installs Homebrew Channel from
  them. Importing a backup asks before adding the repositories in it.
- 📝 Apps without a short description in their repository show the one from their manifest.
- 🩹 Running the bridge from a clone (`pnpm bridge`) served an old copy of the local page if `pnpm pack` had ever run
  there; it now always serves the fresh build, and packing cleans up after itself.
- 📖 The README, the release notes and the app's read-me point to the local page (http://localhost:5199) next to
  lg.scoty.uk.

## 1.0.4 — 2026-10-11

- 🌙 **TVs in standby.** When the TV is off but still reachable (LG's Quick Start+ / "Always Ready"), installing,
  updating and removing apps work as before, but Launch is disabled with a note saying why — the TV would accept the
  launch and show nothing. The apps pages notice within a few seconds when you turn the TV on. If only the picture is
  turned off (screen off), launching an app turns it back on.
- 🫧 No more flashing while the bridge is down: the page stays on "The bridge isn't connected" while it retries in
  the background (it used to show the page for a moment on every attempt), and only the dot in the top-bar pill
  pulses. It switches to the connected page by itself once the bridge is back.
- 🔑 "Make a new key" says why it's greyed out when the bridge isn't connected (the bridge makes the key).
- ⚠️ On rooted TVs, "New key made for this TV" warns first that adding a key turns off the `alpine` password from
  the next restart (Homebrew Channel only sets it while `authorized_keys` doesn't exist) — for every tool — and to
  keep a backup of the key.
- 🔔 The "Bridge vX is available" notice only names a bridge that is actually published — it appeared too early
  when the site was updated before the release was tagged.

## 1.0.3 — 2026-10-10

- 🩹 `npx lg-dev-manager-bridge` works again: 1.0.2's npm package stopped at start with
  `Cannot find package 'sea'` (the build dropped the `node:` prefix of a Node.js module). The app downloads
  weren't affected.
- 🧪 CI and the publish workflow now install and run the packed npm package exactly as npx does — start it, pair
  and SSH to mock TVs — before anything is published.
- 🐞 Issue forms for bugs, connection problems and feature requests, and a security policy.

## 1.0.2 — 2026-10-10

- 🖥️ **The bridge as an app — no Node.js needed.** One download for Windows (`.exe`), macOS (`.dmg`, Apple
  Silicon and Intel) and Linux (`.tar.gz`, x64 and ARM64) on the GitHub release. Open it: it shows the pairing
  token and opens https://lg.scoty.uk. It carries Node.js, the bridge and the local page in one file.
- 🔄 The "new bridge available" notice says how to update the way you run it: the app, npx or the source code.
- 🧩 The Bridge page lists the app as a third way to run the bridge.
- 💬 Starting a second bridge on the same port says that one is probably already running.
- 🧾 `--license` prints the licenses of the bridge and everything it includes.

## 1.0.1 — 2026-10-10

- 📺 webOS versions show LG's name first: `26 (11.0.2)`, `25 (10.3.1)` (Device info, Devices, the add-TV wizard).
- 🧭 The TV switcher stays at the bottom of the sidebar; opening a submenu no longer pushes it out of view.
- 📦 The npm package is half the size (about 1 MB): the bundled web app leaves out the old `.woff` font copies,
  which no supported browser loads. The npm page now shows the full project README.
- 🟢 Node.js 22.12 or newer everywhere — npx and running from source (CI tests both 22.12 and 24).
- ⚠️ "Not affiliated with or endorsed by LG Electronics" in the README and at the bottom of every page.
- 🍿 README: why the Litefin repo exists, Node.js requirements, a bit more colour.
- 🚀 The bridge is published from GitHub Actions with npm trusted publishing (no token).

## 1.0.0 — 2026-10-09

Web app (`web-v1.0.0`, https://lg.scoty.uk) and bridge (`bridge-v1.0.0`, `npx lg-dev-manager-bridge`), released together.

Manage LG webOS TVs, rooted (Homebrew Channel) or in Developer Mode, from your browser. Run the bridge on your computer with `npx lg-dev-manager-bridge@latest`, open the site (or the local page at http://localhost:5199) and paste the pairing token.

### Highlights
- Full parity with dev-manager-desktop: devices and the add-TV wizard, installed apps, the Homebrew repository, IPK install, files, terminal, device info, screenshots, Dev Mode session renewal, and debug tools (system log, log levels, kernel log, crash reports, luna monitor).
- Litefin repo: every webOS build of the latest Litefin releases, installable directly.
- Your TVs, keys and passwords stay in your browser. They are only ever sent to your own bridge, which listens on 127.0.0.1 and needs a pairing token.
- Light and dark themes, command palette, console showing every command run on the TV.

### Since the preview
- Security review: hardened bridge (crash- and hang-proof against hostile input, DNS-rebinding and frame protection, stricter origins, limits), stricter CSP, safer backup import.
- Luna monitor: capturing again works (ls-monitor is stopped on the TV), answered calls show green.
- Icon-rail submenus, masked pairing token, bridge update notice, phone/tablet notice.

See the README for demos and details. Licensed under Apache-2.0.

### Bridge
- Published to npm as `lg-dev-manager-bridge`; serves the web app at http://localhost:5199 (the local page); `--no-ui` turns that off.
- Run from a clone with `pnpm build && pnpm bridge`.
