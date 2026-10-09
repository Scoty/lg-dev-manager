# Changelog

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
