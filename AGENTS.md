# AGENTS.md

Guidance for anyone — human or AI coding agent — working in this repository.
Read this and `PLAN.md` before making changes.

## What this project is

A web rebuild of [webosbrew/dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop):
a tool for managing LG webOS TVs in **Developer Mode** or **rooted** (Homebrew Channel) — install apps,
browse the Homebrew repo, manage files, open a shell, read logs, renew the Dev Mode session.

It has two parts (see `PLAN.md` §1 for why):

- `apps/web` — static React UI, hosted on GitHub Pages, styled after **Adminator 2026**.
- `apps/bridge` — small Node service that owns all SSH/SFTP/TCP traffic to the TV.
- `packages/protocol` — the shared, typed contract between the two. **Change it first, then both sides.**

## Golden rules

1. **The browser never talks to the TV directly.** Every TV operation is a typed RPC in
   `packages/protocol`, implemented in the bridge. No generic "open socket to host:port" RPC — ever.
2. **Bridge security stays on.** Default bind `127.0.0.1`, Origin allowlist, pairing token required.
   Don't add flags that disable these without an explicit, documented reason.
3. **Private keys and passwords never reach the browser's storage** and never appear in logs.
   They live in the bridge's ares-cli-compatible store (`~/.webos/ose/novacom-devices.json`, `~/.ssh/`).
   Redact them in error messages.
4. **Behavioural parity with the original.** When implementing a feature, read the matching code in
   dev-manager-desktop (`src/app/**` for UI flow, `src-tauri/src/**` for backend behaviour) and keep its
   luna calls, paths and fallbacks (e.g. `dev/listApps` → `listApps`, IPK temp dir `/media/developer/temp`).
   Note the source file in a comment when porting non-obvious logic.
5. **Adminator look, not Adminator code dump.** Port the design tokens (`_tokens.scss`), shell, and
   component styles into `apps/web/src/styles/`. Use CSS variables only — no hard-coded colours.
   Both light and dark themes must work for every screen. No Bootstrap, no jQuery.
6. **Destructive TV actions confirm first** (remove app, delete files, uninstall Homebrew Channel, reboot).
7. **No secrets in the repo.** No tokens, keys, IPs of real devices, or personal hostnames in code,
   tests, fixtures or screenshots.

## Tech stack

- pnpm workspaces, Node ≥ 22, TypeScript strict everywhere.
- Web: Vite, React 19, React Router, TanStack Query, xterm.js, SCSS (Adminator tokens).
- Bridge: `ws`, `ssh2`, zod. No native modules (must run in Docker on ARM and x86).
- Tests: Vitest, Playwright, `tools/mock-tv` (an ssh2 server that fakes webOS luna-send + filesystem).

## Commands

```bash
pnpm install
pnpm dev            # web (Vite) + bridge together, with mock TV
pnpm dev:web        # UI only
pnpm dev:bridge     # bridge only
pnpm test           # unit + integration (uses mock TV)
pnpm lint && pnpm typecheck
pnpm build          # web → apps/web/dist, bridge → apps/bridge/dist
```

(These are the target scripts — keep them working as the repo grows.)

## Conventions

- **Feature folders** in `apps/web/src/features/<feature>/` — page, components, hooks, api calls together.
- **RPC naming:** `<area>.<verb>` — `device.add`, `apps.install`, `files.list`, `luna.call`, `shell.open`.
  Long-running ops stream progress events keyed by an operation id.
- **Errors:** bridge returns `{ code, message, detail? }`; UI shows `message` and offers `detail` in an expander
  (same idea as the original's message-trace dialog).
- **Commits:** Conventional Commits (`feat(apps): …`, `fix(bridge): …`). Small, focused PRs per milestone item.
- **Accessibility:** keyboard reachable, visible focus ring (`--primary-ring`), labelled form fields.
- Keep `PLAN.md`'s checklist up to date when a feature lands.

## Testing expectations

- Every new RPC gets a bridge integration test against the mock TV.
- Every page gets a Playwright smoke test (renders in light + dark, no console errors).
- Real-TV checks are done by the owner; when a change needs one, say so in the PR description with steps.

## Licensing

- Original app: Apache-2.0 — keep attribution in `NOTICE` when porting code or text.
- Adminator: MIT — keep its copyright notice in `NOTICE` and in the ported SCSS header.
- This repo: **❓ to be decided by owner** (default proposal: Apache-2.0, matching the original).

## Decisions

| Topic | Decision | Status |
|---|---|---|
| Browser↔TV transport | Local bridge over authenticated WebSocket | Decided (technical necessity) |
| Where the bridge runs | — | ❓ |
| UI framework | React + Vite + TS (proposed) | ❓ |
| v1 scope | All of PLAN.md §3, delivered by milestone | ❓ |
| Device/key storage | Bridge side, ares-cli compatible (proposed) | Default |
| Repo license | Apache-2.0 (proposed) | Default |
| Hosting | GitHub Pages after M3 | Decided |
