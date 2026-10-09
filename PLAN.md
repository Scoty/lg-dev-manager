# LG Dev Manager (web) — Plan

A browser-based rebuild of [webosbrew/dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop)
(Tauri + Angular + Rust) with the look of [Adminator 2026](https://github.com/puikinsh/adminator-admin-dashboard),
hosted at **https://lg.scoty.uk** (GitHub Pages, custom domain on Cloudflare DNS).

> **Status:** M7 (Debug tools) done — system log, log levels (PmLog), kernel log, crash reports and the luna bus monitor. All of §3 is in place.
> Public preview deploys to lg.scoty.uk on every push to `main`. Next: M8 (Litefin repo), then M9 (phones), then M10 (Ship).

---

## 1. The one hard constraint: browsers cannot speak SSH

Everything the original app does goes through **SSH to the TV** (port 9922 in Dev Mode, 22 when rooted),
plus raw TCP to the Dev Mode **key server on port 9991**. A web page cannot open raw TCP sockets:

| Browser option | Why it doesn't work on its own |
|---|---|
| `fetch` / WebSocket straight to the TV | TV speaks SSH, not HTTP/WS. |
| Direct Sockets API | Only available to Chrome *Isolated Web Apps*, not normal websites. |
| LG's SSAP WebSocket (port 3000/3001) | Remote-control API only — no installs, files, shell or luna access. |
| Talking to the TV from an `https://` page | Mixed-content rules block `ws://`/`http://` to LAN IPs. |

**Therefore the app is two parts:**

```
┌──────────────────────────┐   WebSocket (JSON-RPC)   ┌───────────────────┐   SSH / SFTP   ┌────────┐
│ Web UI (lg.scoty.uk)     │ ───────────────────────▶ │ Bridge (tiny,     │ ─────────────▶ │ LG TV  │
│ React + TS, Adminator UI │ ◀─────────────────────── │ Node, this PC)    │ ◀───────────── │ webOS  │
└──────────────────────────┘   events, streams        └───────────────────┘   :9991 keysrv └────────┘
```

- **Web UI** — everything you see. Static files on GitHub Pages at `lg.scoty.uk`. Also keeps **all settings**
  (saved TVs, keys, passwords, bridge pairing) in the browser — see *Where settings live* below.
- **Bridge** — a small headless service (~1 process, no UI) that holds the SSH connections and does the
  network calls the browser can't. It is the replacement for the Rust half of the Tauri app.
  It is **stateless about devices**: it gets connection details with each call and keeps them in memory only
  while an SSH connection is pooled (idle connections close after 2 minutes).
  Distributed as a terminal command: `npx lg-dev-manager-bridge` (needs Node 22+). No desktop app, installer or binary downloads (owner decision).
- The bridge can **also serve the Web UI itself** (`http://localhost:5199`), so the app works fully
  offline and without the public site at all.

### Where settings live
- **Saved TVs** (name, address, port, user, key/password): the browser's IndexedDB for the site's origin. Never uploaded
  to the website; sent only to the paired bridge for the call it is making. The bridge never writes them to disk or logs.
- **Bridge pairing** (bridge address + token): browser `localStorage`.
- **On the bridge**: only its own pairing token (`~/.lg-dev-manager/bridge.json`).
- Storage is **per origin**: `lg.scoty.uk`, `localhost:5173` and the bridge-served copy (`localhost:5199`) each have their own list.
  The Devices page has **export / import** (a JSON backup — contains keys, so the UI warns) and **remove all**.
- The public site ships a strict **Content-Security-Policy** (no third-party or inline scripts; connections only to
  itself and to ws/wss bridges) to limit what an injected script could do with stored keys.

### Bridge security (non-negotiable)
Any website you visit could try to talk to `ws://localhost`. So the bridge:
1. binds to `127.0.0.1` only — nothing else on the network can reach it;
2. checks the `Origin` header against an allowlist (`https://lg.scoty.uk` + localhost dev, plus `--allow-origin`);
3. requires a **pairing token** printed at startup, entered once in the Web UI and kept in browser storage;
4. never exposes a generic "connect anywhere" socket — only typed SSH/luna operations (luna URIs validated, params shell-quoted).

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | **pnpm workspaces** | Shares one typed protocol between UI and bridge. |
| Web UI | **Vite + React 19 + TypeScript**, React Router, TanStack Query | Mainstream, fast, easy to host statically. |
| Styling | **Port of Adminator 2026 SCSS tokens + components** (no Bootstrap) | Same CSS variables, light/dark via `data-theme`, shell/sidebar/topbar. |
| Terminal | **xterm.js** (+ fit, search, web-links addons) | Same as original. |
| Bridge | **Node 22 + TypeScript**, `ws`, `ssh2` (SSH + SFTP) | Pure JS SSH, no native build step; runs on Windows, macOS and Linux (x64/ARM). |
| Protocol | Shared `packages/protocol` with **zod** schemas | One source of truth for every RPC call + event. |
| Tests | Vitest (unit), Playwright (UI smoke), a **mock TV** (ssh2 server) for bridge integration tests | Lets CI test without a real TV. |
| CI/CD | GitHub Actions → GitHub Pages at lg.scoty.uk (UI), npm package (bridge CLI) | |

---

## 3. Feature parity checklist (from the original app)

### Devices
- [x] Device list, select active device (sidebar switcher + ⌘K)
- [x] Network scan for LG TVs (SSDP + /24 sweep of the webOS port 3000/3001), pick a TV to fill the address — `device.scan`
- [x] “SSH is off” guidance: TV answers on its webOS port but not on 22 → turn on SSH in Homebrew Channel and restart the TV
- [x] Add-device wizard: mode select (rooted — recommended and preselected — / Dev Mode / manual), Dev Mode checklist, connection check (ports 22, 9922, 9991), verify (key → login → device info), “save anyway”
- [x] Bridge: port check (22, 9922, 9991) — `device.checkConnection`
- [x] Bridge: fetch private key from the Dev Mode **key server** (9991) with passphrase check — `device.fetchKey`, `device.verifyKey`
- [x] Bridge: test login (key or password) — `device.test`
- [x] UI for key fetch / passphrase, with key-server and passphrase hints
- [x] Manual SSH: password or private key (+ key passphrase prompt, checked by the bridge)
- [x] New key made for a TV (the original's “App key”; ed25519, private key kept in the browser) — `device.generateKey`
- [x] Edit / remove device; test connection
- [x] Device info for the wizard — `device.info`
- [x] TV model shown as its series + model number (“LG C4 · OLED55C46LA”) in the wizard, device list, switcher and Apps page; saved with the TV and refreshed in the background (quiet `device.info`)
- [x] Browser-only device store (IndexedDB) with export / import / remove-all
- [ ] Import from ares-cli `novacom-devices.json` + key files (nice-to-have; replaces ares-cli-compatible storage)

### Apps
- [x] Bridge: `cmd.exec` and one-shot `luna.call` (luna-send-pub / luna-send, typed luna errors)
- [x] Installed apps list (`applicationManager/dev/listApps`, fallback `listApps`) with icons from the TV, search, system-app filter
- [x] Launch, remove (`appInstallService/dev/remove`, confirm; Homebrew Channel asks twice)
- [x] App details (with the Homebrew repo info): “Homebrew repo details” in an installed app's menu
- [x] Install IPK from a local file (file picker or drag & drop → bridge memory → `/media/developer/temp` over SFTP or `cat` → `appInstallService/dev/install`, sha256 check, progress)
- [x] **Homebrew repository** browser (`repo.webosbrew.org/api`, all pages, fetched and cached by the bridge — `repo.list`), search, All / Installed / Updates filters
- [x] Repo app details: description (allow-listed HTML), screenshots and icons through the bridge (`repo.image`, `repo.description`), project page, root badges
- [x] Install / update / install beta from the repo (`apps.installFromRepo`): Homebrew Channel downloads the IPK on the TV; otherwise the bridge downloads it, checks the sha256 and dev-installs; refuses ids owned by LG Store / system apps (`findInstallLocation`)
- [x] Compatibility check (webOS range, SoC list, root via `device.hbchannel`) with an “Install anyway” confirm; “update available” badges and Update buttons on the Installed page
- [x] Homebrew Channel aware install path (`org.webosbrew.hbchannel.service/install`, IPK served over an SSH reverse tunnel), hbchannel removal flow

### Files
- [x] SFTP browser: list (owners, modes, symlink targets, read-only lock), navigate (breadcrumbs, typed path, back / forward / up / home), sort, create folder, delete (`rm -r`, confirmed), rename — `files.*`
- [x] Upload (button or drag & drop, replace confirm) and download with progress; preview text and images (the original opened files in a desktop app)
- [x] Free space for the current folder (`device.storage` with a path)
- [x] Storage usage (developer partition, on the Apps page)

### Terminal
- [x] Full PTY shell over SSH (xterm.js, own connection per shell), resize, multiple tabs on any TV, kept across page changes, reconnect — `shell.*`
- [x] "Dumb" terminal fallback when the TV refuses a PTY (command + output + exit code), or on request

### Device info
- [x] System info (`tv.systemproperty/getSystemInfo`, `osInfo/query`, `sdx/getDeviceUuid`) — model, webOS, firmware, OTA ID, SoC
- [x] **Dev Mode session**: live countdown from `developer.lge.com/secure/CheckDevModeSession.dev` (token from `/var/luna/preferences/devmode_enabled`, never shown in the console), one-click renew (Developer Mode app launched with `{ extend: true }`) — `devmode.status`, `devmode.renew`
- [x] Automatic renewal: renew URL, shell script generator (cron), IFTTT steps
- [x] Screenshot (`capture/executeOneShot`, fallback `tv.capture/executeOneShot` at 1920×1080) → layer choice — `device.screenshot` (root). The TV's temp file is deleted at once (and leftovers from interrupted captures swept); shots are kept in this browser (IndexedDB) as a gallery: older/newer arrows, thumbnails, select, download one or many (.zip), delete
- [x] Homebrew Channel card: installed / latest version, rooted, install or update

### Debug
- [x] System log: `tail -f /var/log/messages` after turning developer logging on (`config/setConfigs`, fallback `pmlogd/setdevlogstatus`); level filter, search, pause, save, clear on TV — `logs.stream` / `logs.stop` / `logs.clear` (root)
- [x] Log levels (PmLog): every context's level, all at once, or a named context (`PmLogCtl show` / `set`) — `pmlog.show`, `pmlog.set` (root)
- [x] Kernel log: `dmesg -w -x` (plain `dmesg` where follow isn't supported), clear with `dmesg -c` (root)
- [x] Crash reports: `/tmp/faultmanager/crash/` (or `/tmp/var/log/reports/librdx/`), titles parsed like the original, view / copy / download (gunzipped), delete — `crashes.*` (Dev Mode too)
- [x] Luna monitor: `ls-monitor -j` grouped into calls and replies, `sender:` / `destination:` / `-` filters, details with payloads, save / open `.jsonl` (root)

### Console (not in the original)
- [x] Console panel at the bottom: every SSH command, transfer and tunnel the bridge runs for this tab, live and past (`cmd.log`)
- [x] “Send commands” checkbox: type commands for the active TV with streaming output, Stop, history (`cmd.stream` / `cmd.cancel`)

### App-level
- [x] Light / dark / system theme (Adminator toggle)
- [x] ⌘K command palette (pages + actions; devices once M3 lands)
- [x] Bridge status indicator + pairing screen + "how to run the bridge" onboarding
- [x] Version handshake (`system.hello` protocol check)
- [ ] Update-available notice for the bridge

---

## 4. Repository layout

```
lg-dev-manager/
├── AGENTS.md               # rules for anyone (human or AI) working in the repo
├── PLAN.md                 # this file
├── NOTICE                  # attribution: dev-manager-desktop (Apache-2.0), Adminator (MIT)
├── apps/
│   ├── web/                # Vite + React UI → GitHub Pages (lg.scoty.uk)
│   │   └── src/
│   │       ├── styles/     # Adminator tokens/shell/components ported to SCSS modules
│   │       ├── shell/      # Sidebar, Topbar, Footer, CommandPalette, ThemeToggle
│   │       ├── bridge/     # typed RPC client, pairing, connection state
│   │       ├── devices/    # IndexedDB device store (browser-only settings)
│   │       └── features/   # devices, apps, files, terminal, info, debug
│   └── bridge/             # Node service
│       └── src/
│           ├── rpc/        # WS server, auth, origin check, dispatch
│           ├── devices/    # key server client, key parsing, port probe (no storage)
│           ├── ssh/        # connection pool, exec, luna, sftp, pty
│           └── http/       # dev-mode renew, repo/IPK download proxy, static UI hosting
├── packages/
│   └── protocol/           # zod schemas + types shared by web and bridge
└── tools/
    └── mock-tv/            # fake webOS over ssh2-server for tests and UI dev
```

---

## 5. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Plan + AGENTS.md + decisions | Owner answers the open questions. |
| M1 ✅ | Skeleton | Monorepo builds; Adminator shell renders (sidebar, topbar, theme toggle) with empty pages; CI green. |
| M2 ✅ | Bridge core | Stateless device RPCs (connection check, key-server key fetch, test login, exec, luna); browser device store; mock TV in tests; lg.scoty.uk deploy. |
| M3 ✅ | Devices + Apps | Add-device wizard end to end; installed apps; launch/remove; install IPK from file. First build worth trying on a real TV. |
| M4 ✅ | Homebrew repo | Browse/search/install/update from repo.webosbrew.org. |
| M5 ✅ | Files + Terminal | SFTP browser with upload/download; xterm PTY. |
| M6 ✅ | Info + Dev Mode renew + screenshot | TV details, session countdown + renew, screenshots. |
| M7 ✅ | Debug tools | PmLog, log reader, dmesg, crashes, ls-monitor. |
| M8 | Litefin repo | **Apps → Litefin repo**: the last 5 Litefin releases from GitHub, every webOS variant installable straight from the page (see §8). |
| M9 | Phones (research) | Find out how the site could be used from a phone without Node/npx — options, trade-offs, a recommendation for the owner to pick (see §9). No code until a choice is made. |
| M10 | Ship | Bridge published to npm (`npx lg-dev-manager-bridge`), README with screenshots, "preview" label removed. |

Scope is **full parity before release** (v1.0 at M10). The site at **lg.scoty.uk** is already public as a *preview*:
every push to `main` deploys it, and it shows which features are still to come.

**Browsers:** lg.scoty.uk talking to the bridge on the same computer (`ws://127.0.0.1`) works in Chrome, Edge and Firefox. Where a browser blocks that, open the bridge-served copy at `http://localhost:5199` instead.

### Hosting setup (lg.scoty.uk)
1. Repo **Settings → Pages → Source: GitHub Actions** (the `Deploy web UI` workflow publishes `apps/web/dist`).
2. Cloudflare DNS for `scoty.uk`: `CNAME lg → scoty.github.io`, **DNS only** (grey cloud) so GitHub can issue the TLS certificate.
3. **Settings → Pages → Custom domain:** `lg.scoty.uk` (also set by `apps/web/public/CNAME`), then tick **Enforce HTTPS**.

---

## 6. Risks

- **Testing needs a real TV.** CI uses the mock TV; each milestone needs a quick check on the owner's TV.
- **Browser "Local Network Access" prompts** (recent Chrome) when a public page talks to localhost — expected; we'll document it.
- **Safari** may block `ws://127.0.0.1` from an https page; workaround is the bridge-served UI (`http://localhost:5199`).
- **Keys in browser storage**: an XSS on lg.scoty.uk could read them. Mitigated by strict CSP, no third-party scripts, and no HTML rendering of TV-supplied text.
- **CORS** on `repo.webosbrew.org` and IPK hosts (GitHub release assets) — the bridge downloads IPKs directly and streams them to the TV anyway, so the browser never needs those files.
- **webOS version differences** (e.g. webOS 11 moving appinstalld temp dir) — mirror the original's fallbacks.

---

## 7. Decisions

Recorded in the AGENTS.md "Decisions" table.

---

## 8. M8 — Litefin repo

**Why.** [Litefin](https://github.com/MoazSalem/litefin) (a lightweight Jellyfin client) publishes several webOS builds per
release — `Litefin-<version>-webOS-Modern.ipk`, `…-Normal.ipk`, `…-Legacy.ipk`, `…-Ultra-Legacy-NoService.ipk` — but the
Homebrew repository can only carry one (the current Normal build). Older TVs need Legacy / Ultra Legacy, newer ones run
Modern best, and sometimes an older version is wanted.

**What.**
- New sidebar entry **Apps → Litefin repo** (`/apps/litefin`), next to Installed and Homebrew repo.
- The **last 5 releases**, newest first, from `https://github.com/MoazSalem/litefin/releases` — published releases only
  (no drafts, no pre-releases).
- One row per release (version, date, release notes link), one **column per variant**: Modern · Normal · Legacy ·
  Ultra Legacy (other webOS variants that show up, e.g. `-NoService`, get their own column or a note; Tizen `.wgt` files
  are ignored). A cell is empty when that release has no such build.
- Each cell: **Install** straight onto the active TV (no download to the computer first), plus the file size. The bridge
  downloads the IPK and installs it the same way as Homebrew repo installs (Dev Mode installer, or Homebrew Channel on
  rooted TVs), with the same progress dialog.
- Variant help from the release notes: Modern — webOS 22+ (2021+ sets); Normal — webOS 6+ (2019+), *try this first*;
  Legacy — webOS 3+ (2017/2018); Ultra Legacy — webOS 1/2 (pre-2017). The TV's own webOS version (known from
  `device.info`) highlights the suggested column.
- Shows which Litefin version is installed on the TV (`apps.list`), and marks that version as installed. All variants share
  one app id, so installing another variant replaces the current one — the UI says so before installing.

**How (bridge, keeping the security rules).**
- New RPCs `litefin.list` and `litefin.install` (or `apps.installFromUrl` restricted to this source). The bridge fetches
  `api.github.com/repos/MoazSalem/litefin/releases` itself — the site's CSP needs no new hosts, and the browser never
  sends the bridge an arbitrary URL: the bridge only downloads asset URLs it got from that API, and only from
  `github.com/MoazSalem/litefin/releases/download/…` (following GitHub's redirect to its release-asset host).
- Cache the release list in memory for ~10 minutes (GitHub allows 60 unauthenticated API calls per hour per IP).
- Verify each download against the asset's `digest` (sha256) when GitHub provides one, and check it is an IPK
  (`ar` archive with a `control.tar.gz`) before installing — same checks as Homebrew repo installs.
- Mock: a fake GitHub releases API in `tools/mock-tv` (`LGDM_LITEFIN_URL`), with pre-releases, drafts, missing variants,
  a bad checksum and more than 5 releases, so the filtering is tested.
- Tests: bridge integration tests (filtering, variant parsing, checksum, install) and a Playwright test of the page.

**To decide while building.** Whether to make the source configurable (other GitHub projects with several builds) —
default: Litefin only, built so another source can be added later.

---

## 9. M9 — Phones (research)

**The problem.** A phone's browser can open lg.scoty.uk, but it still needs a bridge to speak SSH to the TV, and today
the bridge is a Node program (`npx`) on the same computer as the browser. Phones can't run that normally.

**Options to evaluate** (each with: does it work on Android / iOS, setup effort, security, what it changes in the rules):
1. **Bridge on the phone itself** — Android: Termux (`pkg install nodejs`, then `npx lg-dev-manager-bridge`); the phone's
   Chrome reaches it at `127.0.0.1` like a computer does. iOS: no real equivalent (iSH / a-Shell are limited) — check
   whether Node and the bridge actually run there.
2. **Bridge on the TV** (rooted TVs) — a Homebrew app running the bridge so any device on the network can use it.
   Conflicts with two current decisions (bridge only on 127.0.0.1, no on-TV bridge) and would need a new security design
   (pairing, LAN exposure).
3. **Bridge on a computer, used from the phone over the LAN** — conflicts with "127.0.0.1 only / no LAN mode"; would need
   TLS or a pairing scheme that survives untrusted networks.
4. **SSH in the browser over a tiny relay** — SSH implemented in the page (WebAssembly/JS), with only a dumb
   WebSocket-to-TCP relay somewhere (on the TV for rooted TVs). Moves key handling into the page; check the effort and the
   security impact.
5. **An existing phone app as the transport** (Termius, JuiceSSH, Shortcuts on iOS, Tasker on Android…) — check whether any
   of them can be driven from a web page at all (URL schemes, intents) and whether that could cover more than "open a shell".
6. **Packaging** — e.g. a PWA can't open sockets; a small native wrapper could, but that is the "app" the owner ruled out
   for desktop — note it only for completeness.

**Output.** A short write-up with a recommendation and what it would take, for the owner to choose before any code.
The mobile layout of the site itself already works (all pages are checked at phone width).

