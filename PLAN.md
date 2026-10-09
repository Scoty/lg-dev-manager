# LG Dev Manager (web) — Plan

A browser-based rebuild of [webosbrew/dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop)
(Tauri + Angular + Rust) with the look of [Adminator 2026](https://github.com/puikinsh/adminator-admin-dashboard),
hosted at **https://lg.scoty.uk** (GitHub Pages, custom domain on Cloudflare DNS).

> **Status:** M2 (bridge core) done — stateless bridge with SSH/luna/key-server RPCs, browser-only device store, mock TV.
> Public preview deploys to lg.scoty.uk on every push to `main`. Next: M3 (Devices + Apps UI).

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
│ React + TS, Adminator UI │ ◀─────────────────────── │ Node, local/NAS)  │ ◀───────────── │ webOS  │
└──────────────────────────┘   events, streams        └───────────────────┘   :9991 keysrv └────────┘
```

- **Web UI** — everything you see. Static files on GitHub Pages at `lg.scoty.uk`. Also keeps **all settings**
  (saved TVs, keys, passwords, bridge pairing) in the browser — see *Where settings live* below.
- **Bridge** — a small headless service (~1 process, no UI) that holds the SSH connections and does the
  network calls the browser can't. It is the replacement for the Rust half of the Tauri app.
  It is **stateless about devices**: it gets connection details with each call and keeps them in memory only
  while an SSH connection is pooled (idle connections close after 2 minutes).
  Distributed as `npx lg-dev-manager-bridge`, a Docker image (ghcr.io), and later a single binary.
- The bridge can **also serve the Web UI itself** (`http://localhost:5199`), so the app works fully
  offline and without the public site at all.

### Where settings live
- **Saved TVs** (name, address, port, user, key/password): the browser's IndexedDB for the site's origin. Never uploaded
  to the website; sent only to the paired bridge for the call it is making. The bridge never writes them to disk or logs.
- **Bridge pairing** (bridge address + token): browser `localStorage`.
- **On the bridge**: only its own pairing token (`~/.lg-dev-manager/bridge.json`).
- Storage is **per origin**: `lg.scoty.uk`, `localhost:5173` and a NAS-served copy each have their own list.
  The Devices page has **export / import** (a JSON backup — contains keys, so the UI warns) and **remove all**.
- The public site ships a strict **Content-Security-Policy** (no third-party or inline scripts; connections only to
  itself and to ws/wss bridges) to limit what an injected script could do with stored keys.

### Bridge security (non-negotiable)
Any website you visit could try to talk to `ws://localhost`. So the bridge:
1. binds to `127.0.0.1` by default (LAN binding is opt-in, e.g. for a NAS);
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
| Bridge | **Node 22 + TypeScript**, `ws`, `ssh2` (SSH + SFTP) | Pure JS SSH, no native build step; runs anywhere incl. Docker on ARM/x86. |
| Protocol | Shared `packages/protocol` with **zod** schemas | One source of truth for every RPC call + event. |
| Tests | Vitest (unit), Playwright (UI smoke), a **mock TV** (ssh2 server) for bridge integration tests | Lets CI test without a real TV. |
| CI/CD | GitHub Actions → GitHub Pages at lg.scoty.uk (UI), ghcr.io (bridge image), npm (bridge CLI) | |

---

## 3. Feature parity checklist (from the original app)

### Devices
- [ ] Device list, select active device, set default
- [ ] Add-device wizard: mode select (Dev Mode / rooted), connection check (ports 22, 9922, 9991)
- [x] Bridge: port check (22, 9922, 9991) — `device.checkConnection`
- [x] Bridge: fetch private key from the Dev Mode **key server** (9991) with passphrase check — `device.fetchKey`, `device.verifyKey`
- [x] Bridge: test login (key or password) — `device.test`
- [ ] UI for key fetch / passphrase (M3)
- [ ] Manual SSH: password or private key (+ key passphrase prompt)
- [ ] Edit / remove device; inline editor
- [x] Browser-only device store (IndexedDB) with export / import / remove-all
- [ ] Import from ares-cli `novacom-devices.json` + key files (nice-to-have; replaces ares-cli-compatible storage)

### Apps
- [x] Bridge: `cmd.exec` and one-shot `luna.call` (luna-send-pub / luna-send, typed luna errors)
- [ ] Installed apps list (`applicationManager/dev/listApps`, fallback `listApps`)
- [ ] Launch, remove (`appInstallService/dev/remove`), app details
- [ ] Install IPK from a local file (upload → `/media/developer/temp` → `appInstallService/dev/install`, progress)
- [ ] **Homebrew repository** browser (`repo.webosbrew.org/api`), details, install/update, "update available" badges
- [ ] Homebrew Channel aware install path (`org.webosbrew.hbchannel.service/install`), hbchannel removal flow

### Files
- [ ] SFTP browser: list, navigate, sort, create folder, delete, rename
- [ ] Upload (drag & drop) and download with progress
- [ ] Storage usage card

### Terminal
- [ ] Full PTY shell over SSH (xterm.js), resize, multiple tabs
- [ ] "Dumb" exec terminal fallback for devices without PTY

### Device info
- [ ] System info (`tv.systemproperty/getSystemInfo`, `osInfo/query`, `sdx/getDeviceUuid`)
- [ ] **Dev Mode session**: remaining time + one-click renew (`developer.lge.com/secure/CheckDevModeSession.dev`)
- [ ] Renew script generator (for cron / Homebrew Channel)
- [ ] Screenshot (`capture/executeOneShot` / `tv.capture/executeOneShot`) → shown + downloadable

### Debug
- [ ] PmLog: control + set context (`pmlogd/setdevlogstatus`, `config/setConfigs`)
- [ ] Log reader (streaming), dmesg
- [ ] Crash reports list + details
- [ ] Luna-service (ls-monitor) traffic monitor + details

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
| M3 | Devices + Apps | Add-device wizard end to end; installed apps; launch/remove; install IPK from file. First build worth trying on a real TV. |
| M4 | Homebrew repo | Browse/search/install/update from repo.webosbrew.org. |
| M5 | Files + Terminal | SFTP browser with upload/download; xterm PTY. |
| M6 | Info + Dev Mode renew + screenshot | |
| M7 | Debug tools | PmLog, log reader, dmesg, crashes, ls-monitor. |
| M8 | Ship | Docker image, `npx` bridge published, README with screenshots, "preview" label removed. |

Scope is **full parity before release** (v1.0 at M8). The site at **lg.scoty.uk** is already public as a *preview*:
every push to `main` deploys it, and it shows which features are still to come.

**NAS note:** the Docker bridge serves the UI itself on the LAN (`http://<nas>:5199`). Using **lg.scoty.uk** with the NAS bridge needs the bridge on HTTPS (e.g. a `wss://` hostname behind Cloudflare Access); plain LAN `ws://` is blocked from an https page. A bridge on the same computer (`ws://127.0.0.1`) works from lg.scoty.uk in Chrome, Edge and Firefox.

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
