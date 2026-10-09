# LG Dev Manager (web) — Plan

A browser-based rebuild of [webosbrew/dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop)
(Tauri + Angular + Rust) with the look of [Adminator 2026](https://github.com/puikinsh/adminator-admin-dashboard),
hosted on GitHub Pages.

> **Status:** M1 (skeleton) done — shell, theming, bridge pairing. Next: M2 (bridge core).

---

## 1. The one hard constraint: browsers cannot speak SSH

Everything the original app does goes through **SSH to the TV** (port 9922 in Dev Mode, 22 when rooted),
plus raw TCP to the Dev Mode **key server on port 9991**. A web page cannot open raw TCP sockets:

| Browser option | Why it doesn't work on its own |
|---|---|
| `fetch` / WebSocket straight to the TV | TV speaks SSH, not HTTP/WS. |
| Direct Sockets API | Only available to Chrome *Isolated Web Apps*, not normal websites. |
| LG's SSAP WebSocket (port 3000/3001) | Remote-control API only — no installs, files, shell or luna access. |
| Talking to the TV from an `https://*.github.io` page | Mixed-content rules block `ws://`/`http://` to LAN IPs. |

**Therefore the app is two parts:**

```
┌──────────────────────────┐   WebSocket (JSON-RPC)   ┌───────────────────┐   SSH / SFTP   ┌────────┐
│ Web UI (GitHub Pages)    │ ───────────────────────▶ │ Bridge (tiny,     │ ─────────────▶ │ LG TV  │
│ React + TS, Adminator UI │ ◀─────────────────────── │ Node, local/NAS)  │ ◀───────────── │ webOS  │
└──────────────────────────┘   events, streams        └───────────────────┘   :9991 keysrv └────────┘
```

- **Web UI** — everything you see. Static files, deployable to GitHub Pages.
- **Bridge** — a small headless service (~1 process, no UI) that holds the SSH connections and does the
  network calls the browser can't. It is the replacement for the Rust half of the Tauri app.
  Distributed as `npx lg-dev-manager-bridge`, a Docker image (ghcr.io), and later a single binary.
- The bridge can **also serve the Web UI itself** (`http://localhost:5199`), so the app works fully
  offline and without GitHub Pages at all.

### Bridge security (non-negotiable)
Any website you visit could try to talk to `ws://localhost`. So the bridge:
1. binds to `127.0.0.1` by default (LAN binding is opt-in, e.g. for a NAS);
2. checks the `Origin` header against an allowlist (the Pages URL + localhost dev);
3. requires a **pairing token** printed at startup, entered once in the Web UI and kept in browser storage;
4. never exposes a generic "connect anywhere" socket — only typed operations against saved devices.

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
| CI/CD | GitHub Actions → GitHub Pages (UI), ghcr.io (bridge image), npm (bridge CLI) | |

---

## 3. Feature parity checklist (from the original app)

### Devices
- [ ] Device list, select active device, set default
- [ ] Add-device wizard: mode select (Dev Mode / rooted), connection check (ports 22, 9922, 9991)
- [ ] Fetch private key from the Dev Mode **key server** (9991) with passphrase
- [ ] Manual SSH: password or private key (+ key passphrase prompt)
- [ ] Edit / remove device; inline editor
- [ ] Storage compatible with **ares-cli** (`~/.webos/ose/novacom-devices.json` + `~/.ssh/<name>_webos`) — on the bridge side

### Apps
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
│   ├── web/                # Vite + React UI → GitHub Pages
│   │   └── src/
│   │       ├── styles/     # Adminator tokens/shell/components ported to SCSS modules
│   │       ├── shell/      # Sidebar, Topbar, Footer, CommandPalette, ThemeToggle
│   │       ├── bridge/     # typed RPC client, pairing, connection state
│   │       └── features/   # devices, apps, files, terminal, info, debug
│   └── bridge/             # Node service
│       └── src/
│           ├── rpc/        # WS server, auth, origin check, dispatch
│           ├── devices/    # ares-compatible store, key server client
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
| M2 | Bridge core | Pairing, origin check, device store, connection check, key-server key fetch, exec + luna. Mock TV in tests. |
| M3 | Devices + Apps | Add-device wizard end to end; installed apps; launch/remove; install IPK from file. First build worth trying on a real TV. |
| M4 | Homebrew repo | Browse/search/install/update from repo.webosbrew.org. |
| M5 | Files + Terminal | SFTP browser with upload/download; xterm PTY. |
| M6 | Info + Dev Mode renew + screenshot | |
| M7 | Debug tools | PmLog, log reader, dmesg, crashes, ls-monitor. |
| M8 | Ship | GitHub Pages deploy, Docker image, `npx` bridge, README with screenshots. |

Scope is **full parity before release**: the public GitHub Pages site goes live at M8. Before that, preview builds run locally (`pnpm dev`) or from the bridge.

**NAS note:** the Docker bridge serves the UI itself on the LAN (`http://<nas>:5199`). Using the *GitHub Pages* UI with the NAS bridge needs the bridge on HTTPS (e.g. a hostname behind Cloudflare Access); plain LAN `ws://` is blocked from an https page.

---

## 6. Risks

- **Testing needs a real TV.** CI uses the mock TV; each milestone needs a quick check on the owner's TV.
- **Browser "Local Network Access" prompts** (recent Chrome) when a public page talks to localhost — expected; we'll document it.
- **CORS** on `repo.webosbrew.org` and IPK hosts (GitHub release assets) — the bridge downloads IPKs directly and streams them to the TV anyway, so the browser never needs those files.
- **webOS version differences** (e.g. webOS 11 moving appinstalld temp dir) — mirror the original's fallbacks.

---

## 7. Decisions

Recorded in the AGENTS.md "Decisions" table.
