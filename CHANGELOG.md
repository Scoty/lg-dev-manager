# Changelog

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
