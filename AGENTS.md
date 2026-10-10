# AGENTS.md

Guidance for anyone — human or AI coding agent — working in this repository.
Read this and `PLAN.md` before making changes.

## What this project is

A web rebuild of [webosbrew/dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop):
a tool for managing LG webOS TVs in **Developer Mode** or **rooted** (Homebrew Channel) — install apps,
browse the Homebrew repo, manage files, open a shell, read logs, renew the Dev Mode session.

It has two parts (see `PLAN.md` §1 for why):

- `apps/web` — static React UI, hosted at **https://lg.scoty.uk** (GitHub Pages), styled after **Adminator 2026**.
  It is the only place user settings are stored.
- `apps/bridge` — small, **stateless** Node service that owns all SSH/SFTP/TCP traffic to the TV.
- `tools/mock-tv` — fake webOS TV (SSH + luna-send + key server) for tests and UI development.
- `packages/protocol` — the shared, typed contract between the two. **Change it first, then both sides.**

## Golden rules

1. **The browser never talks to the TV directly.** Every TV operation is a typed RPC in
   `packages/protocol`, implemented in the bridge. No generic "open socket to host:port" RPC — ever.
2. **Bridge security stays on.** Bind `127.0.0.1` only (no LAN mode), Origin allowlist, pairing token required,
   Host header checked. The Vite dev origins are accepted only with `--dev` (`pnpm dev:bridge`).
   Don't add flags that disable these without an explicit, documented reason. Anything a web page can send the
   bridge (frames, URLs, uploads) must fail that request, never the process — see PLAN.md §10.
3. **User settings live only in the browser.** Saved TVs (names, addresses, keys, passwords) are kept in
   IndexedDB (`apps/web/src/devices/store.ts`) and the bridge pairing in `localStorage`. Nothing is ever sent to
   the website or any third party. Device details go **only to the paired bridge**, inside the RPC that needs them.
   The bridge must **never persist** device details (no device files, no caches on disk) and must **never log or
   echo** keys/passwords — not in logs, error messages or `detail`. Only its own pairing token is stored on disk.
   Keep the production Content-Security-Policy strict (no third-party/inline scripts, no new `connect-src` hosts
   without a reason), and never render TV-supplied text as HTML.
4. **Behavioural parity with the original.** When implementing a feature, read the matching code in
   dev-manager-desktop (`src/app/**` for UI flow, `src-tauri/src/**` for backend behaviour) and keep its
   luna calls, paths and fallbacks (e.g. `dev/listApps` → `listApps`, IPK temp dir `/media/developer/temp`).
   Note the source file in a comment when porting non-obvious logic.
5. **Adminator look, not Adminator code dump.** Port the design tokens (`_tokens.scss`), shell, and
   component styles into `apps/web/src/styles/`. Use CSS variables only — no hard-coded colours.
   Both light and dark themes must work for every screen. No Bootstrap, no jQuery.
6. **Destructive TV actions confirm first** (remove app, delete files, uninstall Homebrew Channel, reboot).
7. **No secrets in the repo.** No tokens, keys, IPs of real devices, or personal hostnames in code,
   tests, fixtures or screenshots. (The public site domain `lg.scoty.uk` is the one intended exception.)
   Use RFC 5737 addresses (`192.0.2.x`) in examples and tests.

## Tech stack

- pnpm workspaces, TypeScript strict everywhere. **Node.js 22.12 or newer** for everything — the npm bridge and running
  from source (`engines` in both package.json files; Vite needs 22.12). Development uses Node 24 LTS (`.nvmrc`); CI
  builds and tests on both 22.12 and 24 — don't use Node 24-only APIs anywhere.
- Web: Vite, React 19, React Router, TanStack Query, xterm.js, SCSS (Adminator tokens).
- Bridge: `ws`, `ssh2`, zod. No native modules (must run on Windows, macOS and Linux, x64 and ARM).
- Tests: Vitest, Playwright, `tools/mock-tv` (an ssh2 server that fakes webOS luna-send + filesystem).

## Commands

```bash
pnpm install
pnpm dev            # web (Vite) + bridge together
pnpm dev:web        # UI only
pnpm dev:bridge     # bridge only
pnpm --filter @lgdm/mock-tv start   # fake Dev Mode TV on 127.0.0.1:9922 (SSH) / :9991 (key server)
pnpm test           # unit + integration (uses mock TV)
pnpm e2e            # Playwright: built UI + real bridge + mock TVs + fake Homebrew repo (apps/web/e2e)
pnpm dev:rig        # same rig for trying the UI by hand: http://127.0.0.1:5299, token e2e-token
pnpm bridge         # the built bridge as users run it from a clone (serves the local page from apps/web/dist)
pnpm lint && pnpm typecheck
pnpm build          # web → apps/web/dist, bridge → apps/bridge/dist
# Release: see PLAN.md §11 (npm package bundles apps/web/dist as the local page; prepack copies it + LICENSE/NOTICE)
```

(These are the target scripts — keep them working as the repo grows.)

## Conventions

- **Feature folders** in `apps/web/src/features/<feature>/` — page, components, hooks, api calls together.
- **RPC naming:** `<area>.<verb>` — `device.add`, `apps.install`, `files.list`, `luna.call`, `shell.open`.
  Long-running ops stream progress events keyed by an operation id.
- **Console:** helpers take an `SshRunner`; handlers pass `sshFor(session, ctx)` so every command shows up in that client's console. Never put credentials in a command line.
- **Errors:** bridge returns `{ code, message, detail? }`; UI shows `message` and offers `detail` in an expander
  (same idea as the original's message-trace dialog).
- **Commits:** Conventional Commits (`feat(apps): …`, `fix(bridge): …`). Small, focused PRs per milestone item.
- **Accessibility:** keyboard reachable, visible focus ring (`--primary-ring`), labelled form fields.
- Keep `PLAN.md`'s checklist up to date when a feature lands.

## Testing expectations

- Every new RPC gets a bridge integration test against the mock TV.
- Every page gets a Playwright smoke test (renders in light + dark, no console errors) — add it to the `PAGES` list in
  `apps/web/e2e/smoke.spec.ts` (one test per theme walks every page in one tab).
- Keep e2e fast: set up TVs with `addDevModeTv` / `addRootedTv` (saved straight into the browser's store); only tests about
  the add-device wizard use `addDevModeTvWithWizard` / `addRootedTvWithWizard`. No fixed waits (`waitForTimeout`).
- User flows that touch the TV get a Playwright test against the mock TVs (`apps/web/e2e/devices-apps.spec.ts`,
  `repo.spec.ts`, `files-terminal.spec.ts`, `info.spec.ts`, `debug.spec.ts`, `litefin.spec.ts`). The rig's TVs are shared by parallel tests, so each test uses app ids no other test touches.
- Debug tools on the mock TV (followed logs, `PmLogCtl`, `ls-monitor -j`, crash reports) live in `tools/mock-tv/src/debug.ts`;
  followed logs run until the client closes the channel.
- Litefin's GitHub releases are faked by `tools/mock-tv/src/github.ts` (`startMockGithub`, bridge env `LGDM_LITEFIN_URL`).
- LG's Developer Mode session service is faked by `tools/mock-tv/src/lge.ts` (`startMockLge`, bridge env `LGDM_LGE_URL`).
- The Homebrew repository is faked by `tools/mock-tv/src/repo.ts` (`startMockRepo`); point a bridge at it with
  `LGDM_REPO_URL`. Add catalogue entries there for new repo states.
- The rig also runs a TV that refuses PTYs (port 2223) for the simple-shell path. Mock file metadata (owners, modes,
  symlinks) lives in `tools/mock-tv/src/fs.ts`; the interactive shell in `interactive.ts`.
- The mock TV (`tools/mock-tv`) should behave like the real one: when a feature needs a new command or luna call,
  add it there with realistic payloads (see `luna.ts`, `shell.ts`), including failure cases.
- Real-TV checks are done by the owner; when a change needs one, say so in the PR description with steps.

## Licensing

- Original app: Apache-2.0 — keep attribution in `NOTICE` when porting code or text.
- Adminator: MIT — keep its copyright notice in `NOTICE` and in the ported SCSS header.
- This repo: **Apache-2.0** (`LICENSE`, owner decision Oct 2026). Free use as long as the authors are credited: keep
  `NOTICE` up to date and ship `LICENSE` + `NOTICE` with anything distributed (the npm bridge package included).

## Decisions

| Topic | Decision | Status |
|---|---|---|
| Browser↔TV transport | Local bridge over authenticated WebSocket | Decided (technical necessity) |
| Where the bridge runs | On the user's own computer only, bound to `127.0.0.1`. No NAS / Docker / LAN mode (owner decision, Oct 2026) | Decided |
| Bridge distribution | A terminal command only: `npx lg-dev-manager-bridge` (Node 22+), or `pnpm bridge` from a clone. The package also serves the web app at http://localhost:5199 (the "local page"). No desktop/tray app, installers, single binaries, or running the bridge on the TV (owner decision, Oct 2026) | Decided |
| Recommended connection | **Rooted (Homebrew Channel SSH)** is listed first and preselected in the wizard; Developer Mode is for TVs that aren't rooted (owner decision, Oct 2026) | Decided |
| UI framework | React 19 + Vite + TypeScript | Decided |
| v1 scope | **Full parity** with the desktop app (all of PLAN.md §3, incl. Debug tools) before the public release | Decided |
| Device/key storage | **Browser only** (IndexedDB + export/import); bridge is stateless and never writes device details to disk | Decided (owner, Oct 2026) |
| Repo license | Apache-2.0 — free use, attribution via NOTICE (owner, Oct 2026) | Decided |
| Hosting | GitHub Pages with custom domain **lg.scoty.uk** (Cloudflare DNS), public preview from now, v1.0 at M10 | Decided |
| Repository | **github.com/Scoty/lg-dev-manager** | Decided |
| Test devices | Owner tests on both Dev Mode (SSH 9922) and rooted (SSH 22) TVs | Decided |
| Milestone order | M8 Litefin repo (all webOS variants of the last 5 releases), M9 phone research (skipped for now), M10 ship (owner, Oct 2026) | Decided |
| Phones and tablets | Not supported. A notice (`shell/PhoneNotice.tsx`) explains that phone workarounds are risky and asks for a desktop or laptop (owner, Oct 2026) | Decided |
| Litefin repo (M8) | The **bridge** reads Litefin's GitHub releases and installs a build chosen by tag + variant; the browser never sends a URL | Decided (M8) |
| Homebrew repo access | The **bridge** fetches repo.webosbrew.org (index, descriptions, icons, IPKs) so the site's CSP needs no new hosts; descriptions are rendered from an allow-list, never as raw HTML | Decided (M4) |
